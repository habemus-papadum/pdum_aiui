/**
 * Managed Chrome for Testing (CfT) — the recommended browser for `aiui claude`.
 *
 * CfT is Google's automation build of Chrome: version-pinned, no auto-update,
 * and it still honors `--load-extension`, so the aiui DevTools panel loads
 * automatically (branded Chrome ≥ 137 ignores that flag). aiui keeps its own
 * CfT install in the **user-level** cache (`~/.cache/aiui/chrome/`, shared
 * across projects — these are ~160 MB downloads) via `@puppeteer/browsers`,
 * which manages `<cacheDir>/chrome/<platform>-<buildId>/` layouts for us.
 *
 * Because CfT never updates itself, staying current is our job: launches check
 * the latest stable build id (at most once per {@link CHECK_TTL_MS}, with a
 * short network timeout, silently skipped offline) and either prompt or
 * auto-update per `chrome.forTesting` in config. All prompt bookkeeping —
 * when we last checked, which update the user skipped, when an install offer
 * was declined — lives in one small state file next to the installs.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cacheDir } from "@habemus-papadum/aiui-util";
import {
  Browser,
  detectBrowserPlatform,
  getInstalledBrowsers,
  install,
  resolveBuildId,
  uninstall,
} from "@puppeteer/browsers";
import { type ForTestingMode, updateUserConfig } from "./config";
import { choose } from "./prompt";
import { printNote } from "./ui";

/** Re-resolve the latest stable build id at most this often. */
export const CHECK_TTL_MS = 24 * 60 * 60 * 1000;

/** Network budget for the version lookup on the launch path. */
const RESOLVE_TIMEOUT_MS = 4000;

/** One managed CfT install. */
export interface CftInstall {
  buildId: string;
  executablePath: string;
}

/** Prompt/check bookkeeping, persisted in the CfT cache dir. */
export interface CftState {
  /** Epoch ms of the last successful latest-stable lookup. */
  checkedAt?: number;
  /** The latest stable build id as of `checkedAt`. */
  latestBuildId?: string;
  /** Update prompt answered "skip" for this build id — don't re-ask for it. */
  skippedBuildId?: string;
  /** Epoch ms when an install offer was declined — snooze re-asking for a day. */
  installDeclinedAt?: number;
}

/** Where managed CfT builds (and the state file) live. */
export function cftCacheDir(create = true): string {
  return cacheDir("chrome", { create });
}

const STATE_FILE = "update-state.json";

export function readCftState(): CftState {
  try {
    return JSON.parse(readFileSync(join(cftCacheDir(false), STATE_FILE), "utf8")) as CftState;
  } catch {
    return {};
  }
}

export function writeCftState(patch: Partial<CftState>): void {
  const dir = cftCacheDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, STATE_FILE), `${JSON.stringify({ ...readCftState(), ...patch })}\n`);
}

/** Numeric, segment-wise build id comparison ("138.0.7204.94"-style). */
export function compareBuildIds(a: string, b: string): number {
  const as = a.split(".").map(Number);
  const bs = b.split(".").map(Number);
  for (let i = 0; i < Math.max(as.length, bs.length); i++) {
    const diff = (as[i] ?? 0) - (bs[i] ?? 0);
    if (diff) {
      return diff < 0 ? -1 : 1;
    }
  }
  return 0;
}

/** The newest managed CfT install, if any. Never touches the network. */
export async function installedCft(): Promise<CftInstall | undefined> {
  const dir = cftCacheDir(false);
  if (!existsSync(dir)) {
    return undefined;
  }
  const browsers = await getInstalledBrowsers({ cacheDir: dir });
  const chromes = browsers
    .filter((b) => b.browser === Browser.CHROME)
    .sort((a, b) => compareBuildIds(a.buildId, b.buildId));
  const best = chromes.at(-1);
  return best && { buildId: best.buildId, executablePath: best.executablePath };
}

/**
 * The latest stable CfT build id, freshness-limited and offline-tolerant.
 *
 * Consults the network at most once per `maxAgeMs` (persisted in the state
 * file) with a short timeout; on failure it falls back to the last known
 * value, or undefined — callers treat undefined as "can't tell, don't nag".
 */
export async function latestStableCft(
  opts: { maxAgeMs?: number; timeoutMs?: number; now?: number } = {},
): Promise<string | undefined> {
  const { maxAgeMs = CHECK_TTL_MS, timeoutMs = RESOLVE_TIMEOUT_MS, now = Date.now() } = opts;
  const state = readCftState();
  if (state.latestBuildId && state.checkedAt && now - state.checkedAt < maxAgeMs) {
    return state.latestBuildId;
  }
  const platform = detectBrowserPlatform();
  if (!platform) {
    return undefined;
  }
  try {
    const buildId = await withTimeout(
      resolveBuildId(Browser.CHROME, platform, "stable"),
      timeoutMs,
    );
    writeCftState({ checkedAt: now, latestBuildId: buildId });
    return buildId;
  } catch {
    return state.latestBuildId;
  }
}

/**
 * Install the given CfT build into the managed cache and drop superseded
 * builds (they're ~160 MB each; the whole point of the managed dir is that
 * there's exactly one, current, browser in it).
 */
export async function installCft(buildId: string): Promise<CftInstall> {
  const dir = cftCacheDir();
  const fresh = await install({
    browser: Browser.CHROME,
    buildId,
    cacheDir: dir,
    downloadProgressCallback: "default",
  });
  const others = (await getInstalledBrowsers({ cacheDir: dir })).filter(
    (b) => b.browser === Browser.CHROME && b.buildId !== buildId,
  );
  for (const old of others) {
    await uninstall({ browser: Browser.CHROME, buildId: old.buildId, cacheDir: dir });
  }
  return { buildId, executablePath: fresh.executablePath };
}

/**
 * Bring the managed CfT to the latest stable (the `aiui chrome install` /
 * `update` implementation). Unlike the launch path this resolves with no
 * timeout — an explicit command is allowed to wait on the network — and
 * reports what it did.
 */
export async function ensureLatestCft(
  report: (line: string) => void,
): Promise<CftInstall & { outcome: "current" | "installed" | "updated" }> {
  const platform = detectBrowserPlatform();
  if (!platform) {
    throw new Error("could not detect a supported platform for Chrome for Testing");
  }
  const latest = await resolveBuildId(Browser.CHROME, platform, "stable");
  writeCftState({ checkedAt: Date.now(), latestBuildId: latest });
  const current = await installedCft();
  if (current && compareBuildIds(current.buildId, latest) >= 0) {
    report(`Chrome for Testing ${current.buildId} is up to date`);
    return { ...current, outcome: "current" };
  }
  report(
    current
      ? `updating Chrome for Testing ${current.buildId} → ${latest}…`
      : `installing Chrome for Testing ${latest}…`,
  );
  const fresh = await installCft(latest);
  report(`Chrome for Testing ${latest} installed at ${fresh.executablePath}`);
  return { ...fresh, outcome: current ? "updated" : "installed" };
}

/**
 * The launch-path CfT sync: decide which browser this session should use, and
 * (interactively, when allowed) offer to install or update the managed CfT.
 *
 * Returns the CfT executable path to prefer, or undefined to fall back to the
 * system Chrome. Callers only invoke this when config names no browser
 * explicitly (no `chrome.executablePath` / `chrome.channel`).
 *
 * The mode ladder (`chrome.forTesting`, default "prompt"):
 *  - "off"    — never check, never prompt; an already-installed managed CfT is
 *               still used (install one deliberately with `aiui chrome install`).
 *  - "auto"   — install/update to latest stable without asking.
 *  - "prompt" — offer to install when missing, offer to update when stale;
 *               answers can rewrite the mode in the user config.
 *
 * Nothing here ever blocks a non-interactive session: without a TTY (or under
 * CI, or in print mode) this degrades to "use whatever is already installed".
 * Downloads are likewise interactive-only — even "auto" won't pull ~160 MB
 * into a headless one-shot.
 */
export async function syncChromeForTesting(opts: {
  mode: ForTestingMode;
  interactive: boolean;
  now?: number;
}): Promise<string | undefined> {
  const { mode, interactive, now = Date.now() } = opts;
  const current = await installedCft();
  if (mode === "off" || !interactive) {
    return current?.executablePath;
  }

  if (!current) {
    return offerInstall(mode, now);
  }

  const latest = await latestStableCft({ now });
  if (!latest || compareBuildIds(latest, current.buildId) <= 0) {
    return current.executablePath;
  }
  return offerUpdate(mode, current, latest);
}

/** No managed CfT: install silently (auto) or ask (prompt). */
async function offerInstall(mode: "prompt" | "auto", now: number): Promise<string | undefined> {
  const latest = await latestStableCft({ now });
  if (!latest) {
    return undefined; // offline / undetectable platform — don't nag, don't block
  }
  if (mode === "auto") {
    printNote(`installing Chrome for Testing ${latest} (chrome.forTesting: "auto")…`);
    return (await installCft(latest)).executablePath;
  }
  const state = readCftState();
  if (state.installDeclinedAt && now - state.installDeclinedAt < CHECK_TTL_MS) {
    return undefined; // declined recently — don't re-ask every launch
  }
  const answer = await choose(
    "Chrome for Testing isn't installed. It's the recommended browser for aiui — " +
      "version-pinned, separate from your real Chrome, and it auto-loads the aiui " +
      `DevTools panel (branded Chrome can't). Download ${latest} (~160 MB) to ${cftCacheDir(false)}?`,
    [
      { key: "y", label: "yes, install it" },
      { key: "n", label: "not now — use the regular Chrome (asks again tomorrow)" },
      { key: "never", label: 'never — stop offering (writes chrome.forTesting: "off")' },
    ],
    "y",
  );
  if (answer === "y") {
    return (await installCft(latest)).executablePath;
  }
  if (answer === "never") {
    const file = updateUserConfig((c) => {
      c.chrome = { ...c.chrome, forTesting: "off" };
    });
    printNote(`wrote chrome.forTesting: "off" to ${file}`);
  } else {
    writeCftState({ installDeclinedAt: now });
  }
  return undefined;
}

/** Managed CfT is stale: update silently (auto) or ask (prompt). */
async function offerUpdate(
  mode: "prompt" | "auto",
  current: CftInstall,
  latest: string,
): Promise<string> {
  if (mode === "auto") {
    printNote(
      `updating Chrome for Testing ${current.buildId} → ${latest} (chrome.forTesting: "auto")…`,
    );
    return (await installCft(latest)).executablePath;
  }
  if (readCftState().skippedBuildId === latest) {
    return current.executablePath;
  }
  const answer = await choose(
    `Your Chrome for Testing (${current.buildId}) is out of date — latest stable is ${latest}. Update?`,
    [
      { key: "y", label: "yes, just this once" },
      { key: "a", label: 'automatically, now and from here on (writes chrome.forTesting: "auto")' },
      {
        key: "s",
        label: `skip ${latest} — keep ${current.buildId}, don't ask again for this version`,
      },
      { key: "never", label: 'never ask again (writes chrome.forTesting: "off")' },
    ],
    "y",
  );
  switch (answer) {
    case "y":
      return (await installCft(latest)).executablePath;
    case "a": {
      const file = updateUserConfig((c) => {
        c.chrome = { ...c.chrome, forTesting: "auto" };
      });
      printNote(`wrote chrome.forTesting: "auto" to ${file}`);
      return (await installCft(latest)).executablePath;
    }
    case "never": {
      const file = updateUserConfig((c) => {
        c.chrome = { ...c.chrome, forTesting: "off" };
      });
      printNote(`wrote chrome.forTesting: "off" to ${file}`);
      return current.executablePath;
    }
    default: // "s"
      writeCftState({ skippedBuildId: latest });
      return current.executablePath;
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
