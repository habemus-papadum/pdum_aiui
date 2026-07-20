/**
 * `aiui remote <host>` — the whole local half of remote development, in one
 * foreground command (subsumes the retired `aiui browser --tunnel`;
 * docs/proposals/aiui-registry.md §5):
 *
 *  1. Finds **or starts** the local session browser (managed browser, intent
 *     client loaded — the shared util/session-browser pipeline, first-run
 *     prompts included). Its profile anchors to the remote host in the user
 *     cache (`~/.cache/aiui/browser-profiles/<host>`), so reconnecting to the
 *     same box reuses the same browser state.
 *  2. Opens ONE ssh connection carrying both directions:
 *     - `-R <browser-port>:localhost:<local debug port>` — hands the local
 *       browser's DevTools endpoint to the remote box (what the remote
 *       `aiui claude --aiui-browser-url` attaches to);
 *     - `-L <port>:localhost:<port>` — proxies the remote channel's web
 *       backend to this machine, so the local intent client / extension can
 *       reach the remote session.
 *  3. Registers the proxy in the channel registry as `kind: "remote"`: `pid` =
 *     this process, `port` = the LOCAL proxy port (consumers dial
 *     `127.0.0.1:<port>` unchanged), `host` = display metadata, `browserUrl` =
 *     the local browser's real debug endpoint. The entry lives exactly as long
 *     as this command: removed on the way out, and a hard kill is caught by
 *     liveness pruning (the pid is ours).
 *
 * One number to remember per direction: the channel port is the SAME on both
 * ends of its forward (the remote channel must listen on it — the printed
 * invocation says so), and the browser port is the fixed REMOTE side of the
 * reverse forward (the local debug port floats per launch).
 */
import { randomUUID } from "node:crypto";
import { registerServer } from "@habemus-papadum/aiui-registry";
import { isCi } from "@habemus-papadum/aiui-util";
import { execa } from "execa";
import { loadAiuiConfig } from "../util/config";
import { findOrStartSessionBrowser, remoteProfileDir } from "../util/session-browser";
import { printError, printNote } from "../util/ui";

/** Fixed REMOTE side of the browser reverse forward (worth pinning: it's what
 * the remote session and any VS Code launch config reference). */
export const DEFAULT_REMOTE_BROWSER_PORT = 9222;

/** Default channel proxy port — same number on both ends of the forward. */
export const DEFAULT_REMOTE_CHANNEL_PORT = 49300;

export interface RemoteOptions {
  /** Channel proxy port, local AND remote end (default 49300). */
  port?: string;
  /** Remote-side port for the browser debug forward (default 9222). */
  browserPort?: string;
  /** Display name for the registry entry (`assignedName`). */
  name?: string;
  /** Profile key in the user cache (default: derived from the host). */
  profile?: string;
  /** Explicit browser user-data dir (escapes the convention). */
  dataDir?: string;
  headless?: boolean;
}

/** The ssh argv: forward-only, fail-loud, both directions on one connection. */
export function sshRemoteArgs(
  target: string,
  browserRemotePort: number,
  localDebugPort: number,
  channelPort: number,
): string[] {
  return [
    // No remote command — the connection exists only to carry the forwards...
    "-N",
    // ...so if either can't be established (port taken), fail loudly instead
    // of holding a half-useful connection open.
    "-o",
    "ExitOnForwardFailure=yes",
    "-R",
    `${browserRemotePort}:localhost:${localDebugPort}`,
    "-L",
    `${channelPort}:localhost:${channelPort}`,
    target,
  ];
}

/** The copy-pasteable command for the remote side. */
export function remoteInvocation(browserRemotePort: number): string {
  return `aiui claude --aiui-browser-url http://127.0.0.1:${browserRemotePort}`;
}

/** The registry entry's display host: the `[user@]` prefix is auth, not identity. */
export function remoteHostLabel(target: string): string {
  return target.includes("@") ? target.slice(target.indexOf("@") + 1) : target;
}

export async function runRemote(target: string, opts: RemoteOptions): Promise<void> {
  const config = loadAiuiConfig();
  const chromeCfg = { ...config.chrome };
  if (chromeCfg.browserUrl) {
    printNote(
      `config pins chrome.browserUrl to ${chromeCfg.browserUrl} — the browser is managed elsewhere`,
      "aiui remote hosts the browser locally; drop chrome.browserUrl on this machine first.",
    );
    return;
  }

  let channelPort: number;
  let browserPort: number;
  try {
    channelPort = parsePort(opts.port, "--port") ?? DEFAULT_REMOTE_CHANNEL_PORT;
    browserPort = parsePort(opts.browserPort, "--browser-port") ?? DEFAULT_REMOTE_BROWSER_PORT;
  } catch (error) {
    printError(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }

  // Find or start the local browser (first-run prompts deliberately included —
  // `aiui remote` may well BE the first aiui command on this machine).
  const interactive = !!process.stdin.isTTY && !!process.stdout.isTTY && !isCi();
  let session: Awaited<ReturnType<typeof findOrStartSessionBrowser>>;
  try {
    session = await findOrStartSessionBrowser({
      flags: {
        chromeProfile: undefined,
        chromeDataDir: opts.dataDir ?? remoteProfileDir(target, opts.profile),
      },
      config: chromeCfg,
      interactive,
      headless: opts.headless,
    });
  } catch (error) {
    printError(
      "the session browser failed to start",
      error instanceof Error ? error.message : String(error),
    );
    process.exitCode = 1;
    return;
  }
  console.log(session.started ? "session browser started" : "session browser already running");
  console.log(`  profile:        ${session.settings.userDataDir}`);
  console.log(`  debug endpoint: ${session.session.browserUrl}`);

  // Advertise the proxy BEFORE the tunnel comes up: the local intent client
  // can already show (and pre-select) the remote channel while ssh
  // authenticates; dialing it simply fails until the forward exists.
  const registration = registerServer({
    port: channelPort,
    tag: randomUUID(),
    kind: "remote",
    host: remoteHostLabel(target),
    assignedName: opts.name,
    browserUrl: session.session.browserUrl,
  });
  // Backstop for abrupt exits; the normal path removes in `finally`. remove()
  // is idempotent, and a SIGKILL is caught by liveness pruning (pid = ours).
  process.on("exit", registration.remove);

  console.log(
    `\nregistered remote channel ${remoteHostLabel(target)} on localhost:${channelPort}` +
      `${opts.name ? ` as "${opts.name}"` : ""}\n` +
      `tunneling  browser → ${target}:${browserPort}   ·   ${target} channel :${channelPort} → localhost:${channelPort}\n\n` +
      `on ${target}, run:\n\n  ${remoteInvocation(browserPort)}\n\n` +
      `(the remote channel must listen on port ${channelPort}; ` +
      "Ctrl-C closes the tunnel and unregisters — the browser stays running.)",
  );
  try {
    const result = await execa(
      "ssh",
      sshRemoteArgs(target, browserPort, session.session.port, channelPort),
      { stdio: "inherit", reject: false },
    );
    if (result.failed && !result.isTerminated) {
      printError(
        `the ssh connection to ${target} exited (code ${result.exitCode})`,
        "A taken port exits immediately (ExitOnForwardFailure) — try another --port / --browser-port. " +
          "The browser is still running; rerun `aiui remote …` to reconnect.",
      );
      process.exitCode = 1;
    }
  } finally {
    registration.remove();
  }
}

function parsePort(raw: string | undefined, flag: string): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const port = Number(raw);
  if (!(Number.isInteger(port) && port >= 0 && port <= 65535)) {
    throw new Error(`invalid ${flag} ${raw} — expected 0..65535`);
  }
  return port;
}
