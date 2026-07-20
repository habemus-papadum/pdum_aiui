/**
 * `aiui remote <host>` — the whole local half of remote development, in one
 * foreground command (docs/proposals/aiui-registry.md §5, evolved to the
 * ControlMaster + registry-poll design):
 *
 *  1. Finds **or starts** the local session browser (the shared
 *     util/session-browser pipeline; first-run prompts included).
 *  2. Opens ONE ssh **ControlMaster** connection — authenticate exactly once;
 *     every forward is added afterwards over the control socket
 *     (`ssh -O forward`), so a taken port never drops the connection and a
 *     port walk never re-prompts for auth.
 *  3. Reverse-forwards the local browser's DevTools endpoint to the remote box
 *     (default remote port 9222, walking upward with narration on collision).
 *  4. Prints the remote invocation — `aiui claude --aiui-browser-url …
 *     --aiui-tag <uuid>` — and **polls the REMOTE machine's registry** over
 *     the master until that tag appears (the registry is the source of truth;
 *     nobody coordinates a channel port). A channel already attached to our
 *     browser forward also matches (the reattach case), and its tag is
 *     adopted.
 *  5. Local-forwards the discovered channel port, health-checks it, and ONLY
 *     THEN registers the `kind: "remote"` entry — mirroring the remote
 *     channel's real tag and cwd, so local tools address the proxy exactly
 *     like the real thing. The entry lives as long as this command.
 *
 * **Reconnect.** Every connection is recorded in a per-host history file
 * (`~/.cache/aiui/remote/<host>.history.json`, last 20, atomic writes):
 * appended as `pending` once the tunnel is up, promoted to `connected` when
 * the channel lands. `aiui remote <host> --reconnect` replays a record — same
 * tag, same ports — against a REMOTE SESSION THAT IS STILL RUNNING (an ssh
 * drop is recoverable; a killed remote claude is a failure, not something we
 * resurrect). With several records, a picker chooses.
 *
 * Failure vocabulary: master died → "connection dropped — reconnect with
 * `aiui remote <host> --reconnect`"; remote channel gone from the remote
 * registry → terminal failure; Ctrl-C → clean disconnect (the browser stays).
 *
 * Known limitation: the remote registry is read at the XDG default
 * (`${XDG_CACHE_HOME:-~/.cache}/aiui/mcp`); a remote AIUI_CACHE override is
 * invisible from here. The dump command assumes a POSIX login shell.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { registerServer, writeFileAtomic } from "@habemus-papadum/aiui-registry";
import { cacheDir } from "@habemus-papadum/aiui-util";
import { select } from "@inquirer/prompts";
import { execa } from "execa";
import { loadAiuiConfig } from "../util/config";
import {
  findOrStartSessionBrowser,
  remoteProfileDir,
  sanitizeHostKey,
} from "../util/session-browser";
import { printError, printNote } from "../util/ui";

/** Preferred REMOTE port for the browser reverse forward (walked on collision). */
export const DEFAULT_REMOTE_BROWSER_PORT = 9222;

/** Preferred LOCAL port for the channel proxy (walked on collision). */
export const DEFAULT_CHANNEL_LOCAL_PORT = 49300;

/** How many consecutive ports a walk tries before giving up. */
export const PORT_WALK_SPAN = 10;

/** How many history records a host keeps. */
export const HISTORY_MAX = 20;

const REGISTRY_POLL_MS = 2000;
const SUPERVISE_MS = 4000;

export interface RemoteOptions {
  /** Preferred local channel-proxy port (walked when taken). */
  port?: string;
  /** Preferred remote-side browser port (walked when taken). */
  browserPort?: string;
  /** Display name for the registry entry + history record. */
  name?: string;
  /** Profile key in the user cache (default: derived from the host). */
  profile?: string;
  /** Explicit browser user-data dir (escapes the convention). */
  dataDir?: string;
  headless?: boolean;
  /** Replay a recorded connection instead of starting a new session. */
  reconnect?: boolean;
}

// ---------------------------------------------------------------------------
// ssh argv builders — pure, tested.

/** The master connection: no forwards (they arrive via `-O forward`), no
 * remote command, keep-alives so a dead link is noticed within ~a minute. */
export function masterArgs(sock: string, target: string): string[] {
  return [
    "-M",
    "-S",
    sock,
    "-N",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
    target,
  ];
}

/** A control-socket operation (`check` | `exit` | `forward` | `cancel`). */
export function ctlArgs(sock: string, target: string, op: string, ...rest: string[]): string[] {
  return ["-S", sock, "-O", op, ...rest, target];
}

export function forwardBrowserArgs(
  sock: string,
  target: string,
  remotePort: number,
  localDebugPort: number,
): string[] {
  return ctlArgs(sock, target, "forward", "-R", `${remotePort}:localhost:${localDebugPort}`);
}

export function forwardChannelArgs(
  sock: string,
  target: string,
  localPort: number,
  remotePort: number,
): string[] {
  return ctlArgs(sock, target, "forward", "-L", `${localPort}:localhost:${remotePort}`);
}

/** Run a command on the remote over the master (multiplexed — no re-auth). */
export function remoteExecArgs(sock: string, target: string, command: string): string[] {
  return ["-S", sock, target, command];
}

/** Emit each remote registry entry as ONE line of JSON (see the module doc's
 * XDG limitation). Missing dir → no output → no channels. */
export const REMOTE_REGISTRY_DUMP =
  'for f in "${XDG_CACHE_HOME:-$HOME/.cache}"/aiui/mcp/*.json; do' +
  ' [ -f "$f" ] && tr -d "\\n" < "$f" && echo; done; true';

// ---------------------------------------------------------------------------
// Remote-registry parsing + matching — pure, tested.

/** The subset of a remote schema-v2 channel entry this command consumes. */
export interface RemoteChannelEntry {
  tag: string;
  port: number;
  cwd: string;
  startedAt: string;
  browserUrl?: string;
}

/** One JSON object per line; junk lines and non-channel entries are skipped. */
export function parseRemoteEntries(raw: string): RemoteChannelEntry[] {
  const entries: RemoteChannelEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const e = parsed as Record<string, unknown>;
    if (
      e.schema === 2 &&
      e.kind === "channel" &&
      typeof e.tag === "string" &&
      typeof e.port === "number" &&
      typeof e.cwd === "string" &&
      typeof e.startedAt === "string"
    ) {
      entries.push({
        tag: e.tag,
        port: e.port,
        cwd: e.cwd,
        startedAt: e.startedAt,
        ...(typeof e.browserUrl === "string" ? { browserUrl: e.browserUrl } : {}),
      });
    }
  }
  return entries;
}

/**
 * The channel we're waiting for: OUR tag wins; else any channel attached to
 * our browser forward (`browserUrl` = the reverse-forwarded endpoint — the
 * reattach case), newest first.
 */
export function matchRemoteChannel(
  entries: RemoteChannelEntry[],
  tag: string,
  browserPort: number,
): { entry: RemoteChannelEntry; via: "tag" | "browser-url" } | undefined {
  const byTag = entries.find((entry) => entry.tag === tag);
  if (byTag) {
    return { entry: byTag, via: "tag" };
  }
  const url = `http://127.0.0.1:${browserPort}`;
  const attached = entries
    .filter((entry) => entry.browserUrl === url)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
  return attached ? { entry: attached, via: "browser-url" } : undefined;
}

/** The copy-pasteable command for the remote side — tagged, so the poll knows
 * which channel is OURS even among other sessions on that box. */
export function remoteInvocation(browserRemotePort: number, tag: string): string {
  return `aiui claude --aiui-browser-url http://127.0.0.1:${browserRemotePort} --aiui-tag ${tag}`;
}

/** The registry entry's display host: the `[user@]` prefix is auth, not identity. */
export function remoteHostLabel(target: string): string {
  return target.includes("@") ? target.slice(target.indexOf("@") + 1) : target;
}

// ---------------------------------------------------------------------------
// The per-host connection history — pure core, atomic file IO.

export interface RemoteConnectionRecord {
  tag: string;
  name?: string;
  /** The remote-side browser port actually established. */
  browserPort: number;
  /** The local channel-proxy port actually established (or preferred, while pending). */
  channelPort: number;
  /** The remote channel's own port, once discovered. */
  remotePort?: number;
  /** The remote channel's working directory, once discovered. */
  remoteCwd?: string;
  profile?: string;
  dataDir?: string;
  createdAt: string;
  lastConnectedAt?: string;
  state: "pending" | "connected";
}

export interface RemoteHistory {
  schema: 1;
  connections: RemoteConnectionRecord[];
}

/** Prepend (or move to front) by tag, capped at `max`. Pure. */
export function appendConnection(
  history: RemoteHistory,
  record: RemoteConnectionRecord,
  max: number = HISTORY_MAX,
): RemoteHistory {
  const rest = history.connections.filter((c) => c.tag !== record.tag);
  return { schema: 1, connections: [record, ...rest].slice(0, max) };
}

/** Patch the record with `tag` (no-op when absent). Pure. */
export function updateConnection(
  history: RemoteHistory,
  tag: string,
  patch: Partial<RemoteConnectionRecord>,
): RemoteHistory {
  return {
    schema: 1,
    connections: history.connections.map((c) => (c.tag === tag ? { ...c, ...patch } : c)),
  };
}

export function historyPath(target: string): string {
  return join(cacheDir("remote"), `${sanitizeHostKey(target)}.history.json`);
}

export function controlSocketPath(target: string): string {
  return join(cacheDir("remote"), `${sanitizeHostKey(target)}.sock`);
}

export function loadHistory(file: string): RemoteHistory {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as RemoteHistory;
    if (parsed?.schema === 1 && Array.isArray(parsed.connections)) {
      return parsed;
    }
  } catch {
    // Missing or torn — fresh history.
  }
  return { schema: 1, connections: [] };
}

function saveHistory(file: string, history: RemoteHistory): void {
  writeFileAtomic(file, `${JSON.stringify(history, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// Control-socket operations.

interface CtlResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

async function ctl(args: string[]): Promise<CtlResult> {
  const result = await execa("ssh", args, { reject: false, all: false });
  return {
    ok: result.exitCode === 0,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
  };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Wait for the master to accept `-O check` (auth may take a while — 2FA). */
async function awaitMaster(
  sock: string,
  target: string,
  masterDied: () => boolean,
): Promise<boolean> {
  for (;;) {
    if (masterDied()) {
      return false;
    }
    if ((await ctl(ctlArgs(sock, target, "check"))).ok) {
      return true;
    }
    await sleep(500);
  }
}

/**
 * Add a forward, walking up from `preferred` with narration — a failed
 * `-O forward` costs nothing (the master stays up, auth is never re-asked).
 */
async function establishForward(
  build: (port: number) => string[],
  preferred: number,
  what: string,
): Promise<number | undefined> {
  for (let port = preferred; port < preferred + PORT_WALK_SPAN; port++) {
    if ((await ctl(build(port))).ok) {
      if (port !== preferred) {
        console.log(`  ${what}: port ${port} (walked up from ${preferred})`);
      }
      return port;
    }
    console.log(`  ${what}: port ${port} is taken — trying ${port + 1}`);
  }
  return undefined;
}

async function healthOk(localPort: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${localPort}/health`, {
      signal: AbortSignal.timeout(1500),
    });
    return res.ok && ((await res.json()) as { ok?: boolean }).ok === true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// The command.

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

  let preferredChannelPort: number | undefined;
  let preferredBrowserPort: number | undefined;
  try {
    preferredChannelPort = parsePort(opts.port, "--port");
    preferredBrowserPort = parsePort(opts.browserPort, "--browser-port");
  } catch (error) {
    printError(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }

  // Reconnect replays a recorded connection; a fresh run mints a tag.
  const histFile = historyPath(target);
  let history = loadHistory(histFile);
  let tag: string;
  let name = opts.name;
  if (opts.reconnect) {
    const record = await pickRecord(history, target);
    if (!record) {
      process.exitCode = 1;
      return;
    }
    tag = record.tag;
    name = name ?? record.name;
    preferredBrowserPort = preferredBrowserPort ?? record.browserPort;
    preferredChannelPort = preferredChannelPort ?? record.channelPort;
    if (opts.profile === undefined && record.profile !== undefined) {
      opts = { ...opts, profile: record.profile };
    }
    if (opts.dataDir === undefined && record.dataDir !== undefined) {
      opts = { ...opts, dataDir: record.dataDir };
    }
  } else {
    tag = randomUUID();
  }
  const browserPortWanted = preferredBrowserPort ?? DEFAULT_REMOTE_BROWSER_PORT;
  const channelPortWanted = preferredChannelPort ?? DEFAULT_CHANNEL_LOCAL_PORT;

  // The local browser (find-or-start; first-run prompts deliberately included).
  const interactive = !!process.stdin.isTTY && !!process.stdout.isTTY;
  let browser: Awaited<ReturnType<typeof findOrStartSessionBrowser>>;
  try {
    browser = await findOrStartSessionBrowser({
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
  console.log(browser.started ? "session browser started" : "session browser already running");
  console.log(`  profile:        ${browser.settings.userDataDir}`);
  console.log(`  debug endpoint: ${browser.session.browserUrl}`);

  // The master: authenticate ONCE (stdio inherited so ssh's own prompts —
  // passwords, host keys, 2FA — work normally); forwards come later.
  const sock = controlSocketPath(target);
  console.log(`\nconnecting to ${target} (control master)…`);
  let masterSettled = false;
  const master = execa("ssh", masterArgs(sock, target), { stdio: "inherit", reject: false });
  const masterResult = master.then((result) => {
    masterSettled = true;
    return result;
  });
  const masterDied = () => masterSettled;

  const finishAfterMaster = async (): Promise<void> => {
    const result = await masterResult;
    if (result.isTerminated) {
      console.log("\ndisconnected — the browser stays running.");
      return;
    }
    printError(
      `the ssh connection to ${target} ended (code ${result.exitCode})`,
      `Reconnect (same tag, same ports): aiui remote ${target} --reconnect`,
    );
    process.exitCode = 1;
  };

  if (!(await awaitMaster(sock, target, masterDied))) {
    await finishAfterMaster();
    return;
  }

  try {
    // Browser reverse forward, walked with narration.
    const browserPort = await establishForward(
      (port) => forwardBrowserArgs(sock, target, port, browser.session.port),
      browserPortWanted,
      "remote browser port",
    );
    if (browserPort === undefined) {
      printError(
        `no free remote port in ${browserPortWanted}..${browserPortWanted + PORT_WALK_SPAN - 1}`,
        "Pick one explicitly with --browser-port.",
      );
      process.exitCode = 1;
      return;
    }

    // Record the connection (pending) the moment it becomes reconnectable.
    history = appendConnection(history, {
      tag,
      ...(name !== undefined ? { name } : {}),
      browserPort,
      channelPort: channelPortWanted,
      ...(opts.profile !== undefined ? { profile: opts.profile } : {}),
      ...(opts.dataDir !== undefined ? { dataDir: opts.dataDir } : {}),
      createdAt: new Date().toISOString(),
      state: "pending",
    });
    saveHistory(histFile, history);

    const invocation = remoteInvocation(browserPort, tag);
    console.log(
      opts.reconnect
        ? `\nwaiting to reattach to the remote channel (tag ${tag}).\n` +
            `If the remote session died, this cannot recover it — start a new one on ${target}:\n\n` +
            `  ${invocation}\n`
        : `\nbrowser forwarded — on ${target}, run:\n\n  ${invocation}\n\n` +
            "waiting for that channel to appear in the remote registry… (Ctrl-C to stop)",
    );

    // Poll the REMOTE registry over the master until our channel shows up.
    let found: { entry: RemoteChannelEntry; via: "tag" | "browser-url" } | undefined;
    while (!found) {
      if (masterDied()) {
        await finishAfterMaster();
        return;
      }
      const dump = await ctl(remoteExecArgs(sock, target, REMOTE_REGISTRY_DUMP));
      found = matchRemoteChannel(parseRemoteEntries(dump.stdout), tag, browserPort);
      if (!found) {
        await sleep(REGISTRY_POLL_MS);
      }
    }
    if (found.via === "browser-url") {
      console.log(
        `found a session already attached to this browser (tag ${found.entry.tag}) — adopting it.`,
      );
      history = updateConnection(history, tag, { tag: found.entry.tag });
      tag = found.entry.tag;
    }
    const remote = found.entry;
    console.log(`remote channel up: tag ${remote.tag} · ${remote.cwd} · port ${remote.port}`);

    // Local forward to it, walked with narration; then prove it answers.
    const channelPort = await establishForward(
      (port) => forwardChannelArgs(sock, target, port, remote.port),
      channelPortWanted,
      "local channel port",
    );
    if (channelPort === undefined) {
      printError(
        `no free local port in ${channelPortWanted}..${channelPortWanted + PORT_WALK_SPAN - 1}`,
        "Pick one explicitly with --port.",
      );
      process.exitCode = 1;
      return;
    }
    for (let i = 0; i < 5 && !(await healthOk(channelPort)); i++) {
      await sleep(500);
    }

    // ONLY NOW the registry entry: the proxy is real. Mirror the remote
    // channel's tag + cwd so local tools address it like the real thing.
    const registration = registerServer({
      port: channelPort,
      tag: remote.tag,
      kind: "remote",
      host: remoteHostLabel(target),
      assignedName: name,
      browserUrl: browser.session.browserUrl,
      cwd: remote.cwd,
    });
    process.on("exit", registration.remove);
    history = updateConnection(history, tag, {
      state: "connected",
      channelPort,
      browserPort,
      remotePort: remote.port,
      remoteCwd: remote.cwd,
      lastConnectedAt: new Date().toISOString(),
    });
    saveHistory(histFile, history);
    console.log(
      `\nregistered remote channel ${remoteHostLabel(target)} on localhost:${channelPort}` +
        `${name ? ` as "${name}"` : ""} — the local intent client can use it now.\n` +
        "(Ctrl-C disconnects and unregisters; the browser stays running.)",
    );

    // Supervise until the master ends: an ssh drop is reconnectable; the
    // remote channel VANISHING from its registry is terminal (its death is a
    // failure we don't paper over).
    try {
      for (;;) {
        if (masterDied()) {
          await finishAfterMaster();
          return;
        }
        await sleep(SUPERVISE_MS);
        if (masterDied()) {
          await finishAfterMaster();
          return;
        }
        if (!(await healthOk(channelPort))) {
          const dump = await ctl(remoteExecArgs(sock, target, REMOTE_REGISTRY_DUMP));
          const still = parseRemoteEntries(dump.stdout).some((entry) => entry.tag === remote.tag);
          if (!still && !masterDied()) {
            printError(
              `the remote channel (tag ${remote.tag}) is gone from ${target}'s registry`,
              "The remote session ended — start a new one with `aiui remote` when ready.",
            );
            process.exitCode = 1;
            return;
          }
        }
      }
    } finally {
      registration.remove();
    }
  } finally {
    // Graceful master shutdown when WE are the one leaving (Ctrl-C lands on
    // the foreground group, so ssh usually beat us to it — this mops up).
    if (!masterDied()) {
      await ctl(ctlArgs(sock, target, "exit")).catch(() => {});
      master.kill();
    }
  }
}

/** The reconnect picker: one record → taken; several → choose; none → error. */
async function pickRecord(
  history: RemoteHistory,
  target: string,
): Promise<RemoteConnectionRecord | undefined> {
  const records = history.connections;
  if (records.length === 0) {
    printError(
      `no recorded connections to ${target}`,
      "Run `aiui remote " + target + "` (without --reconnect) to start one.",
    );
    return undefined;
  }
  if (records.length === 1) {
    return records[0];
  }
  return select({
    message: `Reconnect to which session on ${remoteHostLabel(target)}?`,
    choices: records.map((record) => ({
      name:
        `${record.name ?? record.tag.slice(0, 8)} · ${record.remoteCwd ?? "(cwd unknown)"} · ` +
        `${record.state}${record.lastConnectedAt ? ` · last ${record.lastConnectedAt}` : ""}`,
      value: record,
    })),
  });
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
