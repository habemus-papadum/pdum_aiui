/**
 * The session browser: one user-visible Chrome shared by the human and the
 * agent.
 *
 * In the aiui CLI's default "attach" mode, `aiui claude` launches the browser
 * itself — with a DevTools debug port, the project profile, and the aiui
 * extensions (DevTools panel, intent tool) — and chrome-devtools-mcp
 * *attaches* to it
 * (`--browser-url`) instead of launching a private one. That's what makes the
 * agent's browser the same window the human is looking at: shared tabs,
 * shared state, visible from session start.
 *
 * This module is the shared plumbing under that story — discovery, launch,
 * open-a-tab, and the auto-open decision ladder — so every dev-server sidecar
 * (`aiui vite`) puts its page in the same
 * shared window instead of re-deriving the mechanics. The aiui CLI layers its
 * own affordances on top (config resolution, Chrome for Testing sync, the
 * devtools-extension autoload); nothing here reads config or prompts.
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
import { headlessReason } from "./environment";

/** Chrome writes this into the user data dir when debugging is enabled. */
const ACTIVE_PORT_FILE = "DevToolsActivePort";

/** How long a fresh Chrome gets to bring up its debug endpoint. */
const LAUNCH_TIMEOUT_MS = 20_000;

/** The installed-Chrome release channels a launch can target. */
export const CHROME_CHANNELS = ["stable", "beta", "dev", "canary"] as const;
export type ChromeChannel = (typeof CHROME_CHANNELS)[number];

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
 * Launch the session browser detached (it deliberately outlives the launching
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
  /** Unpacked extensions to load (comma-joined into one `--load-extension`). */
  extensionDirs?: string[];
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
    // Media prompts, pre-answered — this is a *dev* browser (unauthenticated
    // debug port, project-local profile; see docs/guide/warning.md), and the
    // intent tool's dictation + screenshots otherwise re-prompt constantly:
    // Chrome scopes mic permission per-origin (every dev-server PORT is its
    // own origin), and the getDisplayMedia share picker can never be
    // persisted at all.
    //  - auto-accept camera/microphone permission prompts (the *default, real*
    //    devices — fake devices only come from the separate
    //    --use-fake-device-for-media-stream, deliberately not passed). NOT the
    //    older --use-fake-ui-for-media-stream: that flag also hijacks the
    //    getDisplayMedia picker and auto-selects the ENTIRE SCREEN, which
    //    needs macOS Screen Recording permission the CfT binary doesn't have —
    //    every capture then dies with NotReadableError ("Could not start
    //    video source"), silently defeating the tab-capture flag below (this
    //    broke the paint host's screen share; verified against CfT 150).
    "--auto-accept-camera-and-microphone-capture",
    //  - auto-accept a current-tab share (getDisplayMedia({ preferCurrentTab:
    //    true })) — no picker, no gesture, no OS-level screen-recording grant.
    //    No shipped page calls getDisplayMedia any more (the intent client's
    //    hosts capture natively), but the flag is kept: it is harmless, and a
    //    scratch page an agent writes can rely on it. Verified against CfT
    //    150: the call resolves in ~320ms with userActivation.isActive false.
    //    Trap for anyone re-measuring: a Chrome spawned from a process that
    //    lacks the macOS Screen Recording grant inherits that lack, and the
    //    call HANGS instead — test from a real terminal, or headless.
    "--auto-accept-this-tab-capture",
    //  - allow audio PLAYBACK without a user gesture — the outbound half of the
    //    same media posture (the two flags above pre-answer capture). The
    //    intent client's panels play server-pushed speech (the linter's spoken
    //    notes, TTS acks) via Audio.play(), and with keys forwarded from the
    //    target tab the panel document may never receive the gesture Chrome's
    //    autoplay policy wants — the clip would be refused with
    //    NotAllowedError. The SpeechPlayer parks blocked clips and resumes on
    //    a gesture (dev-overlay speech.ts), so outside this browser nothing is
    //    lost — but in the session browser the linter should simply be HEARD.
    "--autoplay-policy=no-user-gesture-required",
  ];
  if (opts.extensionDirs?.length) {
    args.push(`--load-extension=${opts.extensionDirs.join(",")}`);
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

/** The force/suppress escape hatches a sidecar's caller can express. */
export interface BrowserAutoOpenFlags {
  /** Force opening even under CI/SSH/no-display (`--aiui-browser`, `WORKBENCH_BROWSER=1`). */
  browser?: boolean;
  /** Never open a browser for this run (`--aiui-no-browser`, `WORKBENCH_BROWSER=0`). */
  noBrowser?: boolean;
}

/** The config a sidecar's project may have voted with (aiui's `chrome` section). */
export interface BrowserAutoOpenConfig {
  /** `false` opts the project out of browser integration wholesale. */
  enabled?: boolean;
  /** A browser managed elsewhere (usually reverse-tunneled) — attach there. */
  browserUrl?: string;
}

/** What a browser sidecar should do once its dev-server URL is known. */
export type BrowserAction = { kind: "open" } | { kind: "skip" } | { kind: "hint"; reason: string };

/**
 * Decide the browser sidecar's move — pure (env and platform are parameters)
 * so every rung is unit-testable. The ladder, most explicit first, mirrors
 * the aiui CLI's flag-beats-config ordering:
 *
 *  1. Suppress flag → skip, silently. The user said no for this run.
 *  2. Force flag → open, even under CI, over SSH, or with
 *     `chrome.enabled: false` — the force flag exists precisely to overrule
 *     the defaults (e.g. the dev box is "headless" but its display is a
 *     forwarded port away).
 *  3. `chrome.enabled: false` → skip: the config opted this project out of
 *     browser integration wholesale, same as it disables the DevTools MCP.
 *  4. A configured `chrome.browserUrl` → open. The browser deliberately lives
 *     elsewhere (typically the user's local machine, reverse-tunneled — see
 *     docs/guide/remote), so *this* machine being headless is irrelevant:
 *     opening a tab there is exactly the point of the setup.
 *  5. CI or headless (see ./environment) → don't launch a browser nobody
 *     can see; hand back the reason so the caller can print the
 *     port-forwarding hint instead.
 *  6. Otherwise → open.
 */
export function decideBrowserAction(
  args: BrowserAutoOpenFlags,
  config: BrowserAutoOpenConfig = {},
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): BrowserAction {
  if (args.noBrowser) {
    return { kind: "skip" };
  }
  if (args.browser) {
    return { kind: "open" };
  }
  if (config.enabled === false) {
    return { kind: "skip" };
  }
  if (config.browserUrl) {
    return { kind: "open" };
  }
  const reason = headlessReason(env, platform);
  if (reason) {
    return { kind: "hint", reason };
  }
  return { kind: "open" };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
