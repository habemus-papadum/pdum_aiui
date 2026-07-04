/**
 * The session browser: one user-visible Chrome shared by the human and the
 * agent.
 *
 * In the default "attach" mode, aiui launches the browser itself — with a
 * DevTools debug port, the project profile, and the aiui devtools extension —
 * and chrome-devtools-mcp *attaches* to it (`--browser-url`) instead of
 * launching a private one. That's what makes the agent's browser the same
 * window the human is looking at: shared tabs, shared state, visible from
 * session start.
 *
 * There is deliberately no registry file for browsers. Chrome itself writes
 * `DevToolsActivePort` into the user data dir of any instance started with a
 * debug port, and the user data dir is already the profile's identity — so
 * discovery is: read that file, confirm the endpoint answers `/json/version`.
 * A dead file (crash leftovers, stale port) just fails the liveness probe.
 *
 * Security note (documented in docs/guide/warning): the debug endpoint is
 * unauthenticated — any local process can drive the browser through it. It
 * binds to loopback only.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Browser, ChromeReleaseChannel, computeSystemExecutablePath } from "@puppeteer/browsers";
import { execa } from "execa";
import type { ChromeChannel } from "./config";

/** Chrome writes this into the user data dir when debugging is enabled. */
const ACTIVE_PORT_FILE = "DevToolsActivePort";

/** How long a fresh Chrome gets to bring up its debug endpoint. */
const LAUNCH_TIMEOUT_MS = 20_000;

export interface SessionBrowser {
  /** The DevTools endpoint chrome-devtools-mcp attaches to. */
  browserUrl: string;
  port: number;
}

/**
 * A live session browser for this profile, if one is running.
 * Never launches anything; safe to call from non-interactive paths.
 */
export async function discoverSessionBrowser(
  userDataDir: string,
): Promise<SessionBrowser | undefined> {
  const port = readActivePort(userDataDir);
  if (port === undefined) {
    return undefined;
  }
  if (!(await debugEndpointAlive(port))) {
    return undefined;
  }
  return { browserUrl: `http://127.0.0.1:${port}`, port };
}

function readActivePort(userDataDir: string): number | undefined {
  try {
    const [first] = readFileSync(join(userDataDir, ACTIVE_PORT_FILE), "utf8").split("\n");
    const port = Number(first);
    return Number.isInteger(port) && port > 0 ? port : undefined;
  } catch {
    return undefined;
  }
}

async function debugEndpointAlive(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(1000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Which binary a session-browser launch should run: an explicit
 * executablePath (usually the managed Chrome for Testing) wins; otherwise the
 * system install of the requested channel (default stable). Throws when no
 * such browser is installed.
 */
export function sessionBrowserBinary(settings: {
  executablePath?: string;
  channel?: ChromeChannel;
}): string {
  if (settings.executablePath) {
    return settings.executablePath;
  }
  return computeSystemExecutablePath({
    browser: Browser.CHROME,
    channel: RELEASE_CHANNELS[settings.channel ?? "stable"],
  });
}

const RELEASE_CHANNELS: Record<ChromeChannel, ChromeReleaseChannel> = {
  stable: ChromeReleaseChannel.STABLE,
  beta: ChromeReleaseChannel.BETA,
  dev: ChromeReleaseChannel.DEV,
  canary: ChromeReleaseChannel.CANARY,
};

/**
 * Launch the session browser detached (it deliberately outlives the aiui
 * process — it's the user's window too) and wait for its debug endpoint.
 *
 * `debugPort` 0 lets the OS pick a free port; Chrome reports the choice via
 * `DevToolsActivePort`, which is removed first so a stale file from a previous
 * run can't win the poll. Fails fast if the process exits early — the classic
 * cause being an already-running Chrome on the same profile *without* a debug
 * port, which swallows the new invocation as a URL-handoff and exits.
 */
export async function launchSessionBrowser(opts: {
  binary: string;
  userDataDir: string;
  debugPort?: number;
  extensionDir?: string;
  headless?: boolean;
  startUrl?: string;
}): Promise<SessionBrowser> {
  mkdirSync(opts.userDataDir, { recursive: true });
  rmSync(join(opts.userDataDir, ACTIVE_PORT_FILE), { force: true });

  const args = [
    `--remote-debugging-port=${opts.debugPort ?? 0}`,
    `--user-data-dir=${opts.userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
  ];
  if (opts.extensionDir) {
    args.push(`--load-extension=${opts.extensionDir}`);
  }
  if (opts.headless) {
    args.push("--headless");
  }
  args.push(opts.startUrl ?? "about:blank");

  const child = execa(opts.binary, args, {
    detached: true,
    stdio: "ignore",
    reject: false,
    cleanup: false,
  });
  child.unref();
  let exited = false;
  void child.then(() => {
    exited = true;
  });

  const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const found = await discoverSessionBrowser(opts.userDataDir);
    if (found) {
      // Purely informational breadcrumb (pid, when) for humans poking around.
      try {
        writeFileSync(
          join(opts.userDataDir, "aiui-browser.json"),
          `${JSON.stringify({ pid: child.pid, startedAt: new Date().toISOString() })}\n`,
        );
      } catch {}
      return found;
    }
    if (exited) {
      throw new Error(
        "the browser exited before exposing its DevTools endpoint — is another Chrome " +
          "already running on this profile without a debug port? Close it and retry.",
      );
    }
    await sleep(250);
  }
  throw new Error(
    `the browser did not expose its DevTools endpoint within ${LAUNCH_TIMEOUT_MS / 1000}s`,
  );
}

/**
 * Open a URL as a new tab in a session browser, via the DevTools HTTP API
 * (`PUT /json/new` — PUT is required by current Chrome).
 */
export async function openInSessionBrowser(browserUrl: string, url: string): Promise<void> {
  const base = browserUrl.replace(/\/+$/, "");
  const res = await fetch(`${base}/json/new?${encodeURI(url)}`, {
    method: "PUT",
    signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) {
    throw new Error(`the browser refused to open the tab (${res.status} ${res.statusText})`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
