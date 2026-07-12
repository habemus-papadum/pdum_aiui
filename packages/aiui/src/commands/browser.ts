/**
 * `aiui browser` — start (or find) the session browser; `aiui open <url>` —
 * open a page in it.
 *
 * `aiui browser` is how the session browser exists *independently* of a
 * Claude session: locally when you want the window up before (or without)
 * `aiui claude`, and — the headline use — on your **local machine in remote
 * development**, where one command does the whole local half:
 *
 *   aiui browser --tunnel dev-box
 *
 * launches the browser (Chrome for Testing preferred, devtools panel loaded),
 * reverse-tunnels its debug port to `dev-box` on a **fixed remote port**
 * (default 9222 — the remote port is the one worth pinning: it's what the
 * remote session and any VS Code launch config reference; the local port can
 * float), and prints the exact command to run over there. Ctrl-C closes the
 * tunnel; the browser stays.
 *
 * Profiles: without `--tunnel`, the profile is project-local as usual
 * (`.aiui-cache/chrome/<name>` under the cwd). With `--tunnel` there is
 * usually no local checkout to anchor to, so the profile lives in the
 * **user-level cache**, keyed by the tunnel host —
 * `~/.cache/aiui/browser-profiles/<host>` — so reconnecting to the same box
 * reuses the same browser state. `--profile <name>` renames that key;
 * `--data-dir <path>` escapes the convention entirely.
 *
 * Both commands identify the browser the same way `aiui claude` does: by the
 * profile's user data dir, via Chrome's own `DevToolsActivePort` file.
 */
import { join } from "node:path";
import {
  cacheDir,
  discoverSessionBrowser,
  isCi,
  launchSessionBrowser,
  openInSessionBrowser,
  type SessionBrowser,
  sessionBrowserBinary,
} from "@habemus-papadum/aiui-util";
import { execa } from "execa";
import type { AiuiArgs } from "../util/aiui-args";
import { syncChromeForTesting } from "../util/cft";
import {
  buildDevtoolsExtension,
  type ChromeSettings,
  devtoolsExtensionDir,
  findIntentExtension,
  maybeExtensionAutoloadHint,
  resolveChromeSettings,
  warnIntentExtensionState,
} from "../util/chrome";
import { type AiuiConfig, loadAiuiConfig } from "../util/config";
import { printError, printNote } from "../util/ui";
import { ensureProfileNativeHost } from "./extension";

type ChromeConfig = NonNullable<AiuiConfig["chrome"]>;

/** The default *remote* port — the one worth keeping fixed (see module doc). */
export const DEFAULT_REMOTE_PORT = 9222;

export interface BrowserOptions {
  profile?: string;
  dataDir?: string;
  port?: string;
  headless?: boolean;
  open?: string;
  /** `[user@]host` to reverse-tunnel the debug port to (runs until Ctrl-C). */
  tunnel?: string;
  /** Fixed port on the tunnel's remote side (default {@link DEFAULT_REMOTE_PORT}). */
  remotePort?: string;
}

export async function runBrowser(opts: BrowserOptions): Promise<void> {
  const config = loadAiuiConfig();
  const chromeCfg = { ...config.chrome };
  if (chromeCfg.browserUrl) {
    printNote(
      `config pins chrome.browserUrl to ${chromeCfg.browserUrl} — the browser is managed elsewhere`,
      "Run `aiui browser` on the machine that should host it (and drop browserUrl there).",
    );
    return;
  }

  let remotePort: number;
  let debugPort: number | undefined;
  try {
    remotePort = parsePort(opts.remotePort, "--remote-port") ?? DEFAULT_REMOTE_PORT;
    debugPort = parsePort(opts.port, "--port");
  } catch (error) {
    printError(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }

  // With a tunnel, the profile anchors to the *remote host* in the user cache
  // (no local checkout to be project-local to); see the module doc.
  const flags = {
    chromeProfile: opts.tunnel ? undefined : opts.profile,
    chromeDataDir:
      opts.dataDir ?? (opts.tunnel ? tunnelProfileDir(opts.tunnel, opts.profile) : undefined),
  };
  let settings = resolveChromeSettings(flags, chromeCfg);
  if (debugPort !== undefined) {
    settings = { ...settings, debugPort };
  }

  let session = await discoverSessionBrowser(settings.userDataDir);
  if (session) {
    // Keep the profile's NM manifest current even when not launching — the
    // running browser may predate this checkout's native host.
    ensureProfileNativeHost(
      settings.userDataDir,
      (await findIntentExtension()).state === "ready",
      printNote,
    );
    report("session browser already running", settings, session);
    if (opts.open) {
      await openInSessionBrowser(session.browserUrl, opts.open);
      console.log(`opened ${opts.open}`);
    }
  } else {
    const interactive = !!process.stdin.isTTY && !!process.stdout.isTTY && !isCi();
    try {
      const started = await startSessionBrowser({
        flags,
        config: chromeCfg,
        interactive,
        debugPort,
        headless: opts.headless,
        startUrl: opts.open,
      });
      session = started.session;
      settings = started.settings;
    } catch (error) {
      printError(
        "the session browser failed to start",
        error instanceof Error ? error.message : String(error),
      );
      process.exitCode = 1;
      return;
    }
    report("session browser started", settings, session);
  }

  if (opts.tunnel) {
    await runTunnel(opts.tunnel, remotePort, session.port);
  } else {
    printNextSteps(session, remotePort);
  }
}

/** Options for {@link startSessionBrowser}. */
export interface StartSessionBrowserOptions {
  /** CLI identity flags (profile / data dir), reconciled against config. */
  flags?: Pick<AiuiArgs, "chromeProfile" | "chromeDataDir">;
  /** The `chrome` section of the loaded config. */
  config?: ChromeConfig;
  /**
   * Whether prompting is allowed. Interactive launches may offer to
   * install/update Chrome for Testing and print the extension autoload hint;
   * non-interactive ones (CI, or a sidecar whose terminal belongs to another
   * process — `aiui vite`'s browser open) degrade to whatever browser is
   * already installed, silently.
   */
  interactive: boolean;
  /** Override the resolved DevTools debug port (`aiui browser --port`). */
  debugPort?: number;
  /** Launch headless regardless of config (`aiui browser --headless`). */
  headless?: boolean;
  /** Open this URL as the first tab instead of about:blank. */
  startUrl?: string;
}

/**
 * Launch the session browser the way `aiui browser` does — the shared
 * "everything before the window exists" sequence, extracted so other commands
 * (`aiui vite`'s browser sidecar) launch identically instead of re-deriving
 * it:
 *
 *  1. Resolve settings from flags + config.
 *  2. Prefer the managed Chrome for Testing unless config names a browser
 *     explicitly (the sync may prompt to install/update — only when
 *     `interactive`; otherwise it just reports what's installed).
 *  3. Rebuild and load the aiui devtools extension, and pick up the
 *     intent-tool extension's dist/ if its dev loop has produced one
 *     (dev checkouts only).
 *  4. Launch on the profile's user data dir and wait for the debug endpoint.
 *
 * Throws with a remediation-bearing message when no browser can be found or
 * the launch fails; callers decide whether that's fatal (`aiui browser`) or
 * merely a warning (`aiui vite`, where the dev server must keep running).
 */
export async function startSessionBrowser(
  opts: StartSessionBrowserOptions,
): Promise<{ session: SessionBrowser; settings: ChromeSettings }> {
  let cfg = opts.config ?? {};
  const flags = opts.flags ?? {};
  const settle = () => {
    const settings = resolveChromeSettings(flags, cfg);
    return opts.debugPort === undefined ? settings : { ...settings, debugPort: opts.debugPort };
  };
  let settings = settle();

  if (!cfg.executablePath && !cfg.channel) {
    const cft = await syncChromeForTesting({
      mode: cfg.forTesting ?? "prompt",
      interactive: opts.interactive,
    });
    if (cft) {
      cfg = { ...cfg, executablePath: cft };
      settings = settle();
    }
  }
  if (settings.buildExtension) {
    await buildDevtoolsExtension();
  }
  const intent = await findIntentExtension();
  const extensionDirs = [
    devtoolsExtensionDir(),
    intent.state === "ready" ? intent.dir : undefined,
  ].filter((d): d is string => d !== undefined);
  // The extension's channel discovery runs over native messaging, and CfT
  // looks the manifest up in the profile itself — keep it planted there.
  ensureProfileNativeHost(settings.userDataDir, intent.state === "ready", printNote);
  if (opts.interactive) {
    maybeExtensionAutoloadHint(settings, extensionDirs);
    await warnIntentExtensionState(intent);
  }

  let binary: string;
  try {
    binary = sessionBrowserBinary(settings);
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n` +
        "Install Chrome for Testing with `aiui chrome install`, or set chrome.executablePath.",
    );
  }
  const session = await launchSessionBrowser({
    binary,
    userDataDir: settings.userDataDir,
    debugPort: settings.debugPort,
    extensionDirs,
    headless: settings.headless || opts.headless,
    startUrl: opts.startUrl,
  });
  return { session, settings };
}

/**
 * `~/.cache/aiui/browser-profiles/<key>` for a tunneled session browser.
 * Path-only (no mkdir) — the browser launch creates it on first use.
 */
export function tunnelProfileDir(target: string, profile?: string): string {
  const key = profile ?? sanitizeHostKey(target);
  return join(cacheDir("browser-profiles", { create: false }), key);
}

/** "user@dev.example.com" → "dev.example.com", made filesystem-safe. */
export function sanitizeHostKey(target: string): string {
  const host = target.includes("@") ? target.slice(target.indexOf("@") + 1) : target;
  const key = host.replace(/[^A-Za-z0-9._-]/g, "-");
  return key || "remote";
}

/** The ssh argv for the reverse tunnel (exported for tests). */
export function sshTunnelArgs(target: string, remotePort: number, localPort: number): string[] {
  return [
    // No remote command — the connection exists only to carry the forward...
    "-N",
    // ...so if the forward can't be established (remote port taken), fail
    // loudly instead of holding a useless connection open.
    "-o",
    "ExitOnForwardFailure=yes",
    "-R",
    `${remotePort}:localhost:${localPort}`,
    target,
  ];
}

/** The command to run on the remote side, given the tunnel's remote port. */
export function remoteAttachCommand(remotePort: number): string {
  return `aiui claude --aiui-browser-url http://127.0.0.1:${remotePort}`;
}

/**
 * Hold the reverse tunnel open in the foreground (stdio inherited, so ssh's
 * own auth prompts — passwords, host keys, 2FA — work normally). The browser
 * deliberately outlives the tunnel: Ctrl-C here only drops the forward.
 */
async function runTunnel(target: string, remotePort: number, localPort: number): Promise<void> {
  console.log(
    `\ntunneling ${target}:${remotePort} → localhost:${localPort} — on ${target}, run:\n\n` +
      `  ${remoteAttachCommand(remotePort)}\n\n` +
      "(Ctrl-C closes the tunnel; the browser stays running.)",
  );
  const result = await execa("ssh", sshTunnelArgs(target, remotePort, localPort), {
    stdio: "inherit",
    reject: false,
  });
  if (result.failed && !result.isTerminated) {
    printError(
      `the ssh tunnel to ${target} exited (code ${result.exitCode})`,
      "A taken remote port exits immediately (ExitOnForwardFailure) — try another --remote-port. " +
        "The browser is still running; rerun `aiui browser --tunnel …` to reconnect.",
    );
    process.exitCode = 1;
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

function report(title: string, settings: ChromeSettings, session: SessionBrowser): void {
  console.log(title);
  console.log(`  profile:        ${settings.userDataDir}`);
  console.log(`  debug endpoint: ${session.browserUrl}`);
}

/** The no-tunnel closing hint: local attach is automatic; remote needs steps. */
function printNextSteps(session: SessionBrowser, remotePort: number): void {
  console.log(
    "\nAn `aiui claude` in this profile's project attaches automatically. For a *remote*\n" +
      "session, rerun with `--tunnel <[user@]host>` — or do it by hand:\n" +
      `  ssh -N -o ExitOnForwardFailure=yes -R ${remotePort}:localhost:${session.port} <host>\n` +
      `then, on the remote: ${remoteAttachCommand(remotePort)}`,
  );
}

/** `aiui open <url>` — open a page in the running session browser. */
export async function runOpen(
  url: string,
  opts: Pick<BrowserOptions, "profile" | "dataDir">,
): Promise<void> {
  const config = loadAiuiConfig();
  const settings = resolveChromeSettings(
    { chromeProfile: opts.profile, chromeDataDir: opts.dataDir },
    config.chrome ?? {},
  );
  // An explicitly configured endpoint (remote browser) is also openable.
  const browserUrl =
    config.chrome?.browserUrl ?? (await discoverSessionBrowser(settings.userDataDir))?.browserUrl;
  if (!browserUrl) {
    printError(
      "no session browser is running for this profile",
      `Start one with \`aiui browser\` (profile: ${settings.userDataDir}).`,
    );
    process.exitCode = 1;
    return;
  }
  try {
    await openInSessionBrowser(browserUrl, url);
    console.log(`opened ${url}`);
  } catch (error) {
    printError(`couldn't open ${url}`, error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
