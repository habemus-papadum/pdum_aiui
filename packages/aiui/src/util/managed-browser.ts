/**
 * The managed browser — a version-pinned Chromium-family build that aiui
 * downloads and keeps current for `aiui claude`, so a session gets a browser
 * that (unlike branded Chrome ≥ 137) still honors `--load-extension` and takes
 * the media auto-accept flags.
 *
 * Two flavors, chosen by `chrome.managed` (default {@link DEFAULT_MANAGED_FLAVOR}):
 *
 *  - **chromium** — the open-source build. It dodges the "verify you're human"
 *    reCAPTCHA that Google serves to the Chrome-for-Testing automation build,
 *    at the cost of Widevine DRM, some proprietary codecs, and Google account
 *    sign-in. Resolved from the chromium-browser-snapshots "latest" revision.
 *  - **chrome-for-testing** — Google's branded automation build, version-pinned
 *    to latest *stable*.
 *
 * Each flavor keeps its own install (and prompt/check bookkeeping) in a separate
 * **user-level** cache — `~/.cache/aiui/<chromium|chrome>/` — because these are
 * ~150-160 MB downloads shared across projects, and the two builds must never
 * share a directory. `@puppeteer/browsers` manages the
 * `<cacheDir>/<browser>/<platform>-<buildId>/` layouts for us.
 *
 * Because neither flavor auto-updates, staying current is our job: launches
 * check the latest build id (at most once per {@link CHECK_TTL_MS}, with a
 * short network timeout, silently skipped offline) and either prompt or
 * auto-update per `chrome.manage` (was `chrome.forTesting`). All prompt
 * bookkeeping lives in one small state file next to each flavor's installs.
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
import { MANAGED_FLAVORS, type ManagedFlavor, type ManageMode, updateUserConfig } from "./config";
import { choose } from "./prompt";
import { printNote } from "./ui";

/** Re-resolve the latest build id at most this often. */
export const CHECK_TTL_MS = 24 * 60 * 60 * 1000;

/** Network budget for the version lookup on the launch path. */
const RESOLVE_TIMEOUT_MS = 4000;

/** The per-flavor facts that differ between the two managed builds. */
export interface ManagedFlavorSpec {
  flavor: ManagedFlavor;
  /** The `@puppeteer/browsers` browser this flavor installs. */
  browser: Browser;
  /**
   * The tag `resolveBuildId` accepts for "newest": Chrome for Testing tracks
   * the "stable" release channel; Chromium only supports "latest" (a snapshot
   * revision).
   */
  latestTag: string;
  /** Human name for prompts and status. */
  displayName: string;
  /** Cache subdirectory under `~/.cache/aiui/` (also the on-disk browser name). */
  cacheSubdir: string;
  /** Rough download size, for the install prompt. */
  approxSizeMb: number;
}

export const MANAGED_FLAVOR_SPECS: Record<ManagedFlavor, ManagedFlavorSpec> = {
  chromium: {
    flavor: "chromium",
    browser: Browser.CHROMIUM,
    latestTag: "latest",
    displayName: "Chromium",
    cacheSubdir: "chromium",
    approxSizeMb: 150,
  },
  "chrome-for-testing": {
    flavor: "chrome-for-testing",
    browser: Browser.CHROME,
    latestTag: "stable",
    displayName: "Chrome for Testing",
    cacheSubdir: "chrome",
    approxSizeMb: 160,
  },
};

export function flavorSpec(flavor: ManagedFlavor): ManagedFlavorSpec {
  return MANAGED_FLAVOR_SPECS[flavor];
}

/** One managed install. */
export interface ManagedInstall {
  flavor: ManagedFlavor;
  buildId: string;
  executablePath: string;
}

/** Prompt/check bookkeeping, persisted in each flavor's cache dir. */
export interface ManagedState {
  /** Epoch ms of the last successful latest-build lookup. */
  checkedAt?: number;
  /** The latest build id as of `checkedAt`. */
  latestBuildId?: string;
  /** Update prompt answered "skip" for this build id — don't re-ask for it. */
  skippedBuildId?: string;
  /** Epoch ms when an install offer was declined — snooze re-asking for a day. */
  installDeclinedAt?: number;
}

/** Where a flavor's managed builds (and its state file) live. */
export function managedCacheDir(flavor: ManagedFlavor, create = true): string {
  return cacheDir(flavorSpec(flavor).cacheSubdir, { create });
}

/** Every flavor's cache dir — what `aiui clean` sweeps. */
export function allManagedCacheDirs(create = false): string[] {
  return MANAGED_FLAVORS.map((flavor) => managedCacheDir(flavor, create));
}

const STATE_FILE = "update-state.json";

export function readManagedState(flavor: ManagedFlavor): ManagedState {
  try {
    return JSON.parse(
      readFileSync(join(managedCacheDir(flavor, false), STATE_FILE), "utf8"),
    ) as ManagedState;
  } catch {
    return {};
  }
}

export function writeManagedState(flavor: ManagedFlavor, patch: Partial<ManagedState>): void {
  const dir = managedCacheDir(flavor);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, STATE_FILE),
    `${JSON.stringify({ ...readManagedState(flavor), ...patch })}\n`,
  );
}

/**
 * Numeric, segment-wise build id comparison. Handles both shapes: Chrome for
 * Testing's dotted "138.0.7204.94" and Chromium's single-integer snapshot
 * revision "1358901" (one segment → plain numeric compare).
 */
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

/** The newest managed install for a flavor, if any. Never touches the network. */
export async function installedManaged(flavor: ManagedFlavor): Promise<ManagedInstall | undefined> {
  const spec = flavorSpec(flavor);
  const dir = managedCacheDir(flavor, false);
  if (!existsSync(dir)) {
    return undefined;
  }
  const builds = (await getInstalledBrowsers({ cacheDir: dir }))
    .filter((b) => b.browser === spec.browser)
    .sort((a, b) => compareBuildIds(a.buildId, b.buildId));
  const best = builds.at(-1);
  return best && { flavor, buildId: best.buildId, executablePath: best.executablePath };
}

/**
 * The latest build id for a flavor, freshness-limited and offline-tolerant.
 *
 * Consults the network at most once per `maxAgeMs` (persisted in the state
 * file) with a short timeout; on failure it falls back to the last known
 * value, or undefined — callers treat undefined as "can't tell, don't nag".
 */
export async function latestManaged(
  flavor: ManagedFlavor,
  opts: { maxAgeMs?: number; timeoutMs?: number; now?: number } = {},
): Promise<string | undefined> {
  const { maxAgeMs = CHECK_TTL_MS, timeoutMs = RESOLVE_TIMEOUT_MS, now = Date.now() } = opts;
  const state = readManagedState(flavor);
  if (state.latestBuildId && state.checkedAt && now - state.checkedAt < maxAgeMs) {
    return state.latestBuildId;
  }
  const platform = detectBrowserPlatform();
  if (!platform) {
    return undefined;
  }
  try {
    const spec = flavorSpec(flavor);
    const buildId = await withTimeout(
      resolveBuildId(spec.browser, platform, spec.latestTag),
      timeoutMs,
    );
    writeManagedState(flavor, { checkedAt: now, latestBuildId: buildId });
    return buildId;
  } catch {
    return state.latestBuildId;
  }
}

/**
 * Install the given build into the flavor's managed cache and drop superseded
 * builds (they're ~150-160 MB each; the whole point of the managed dir is that
 * there's exactly one, current, browser in it).
 */
export async function installManaged(
  flavor: ManagedFlavor,
  buildId: string,
): Promise<ManagedInstall> {
  const spec = flavorSpec(flavor);
  const dir = managedCacheDir(flavor);
  const fresh = await install({
    browser: spec.browser,
    buildId,
    cacheDir: dir,
    downloadProgressCallback: "default",
  });
  const others = (await getInstalledBrowsers({ cacheDir: dir })).filter(
    (b) => b.browser === spec.browser && b.buildId !== buildId,
  );
  for (const old of others) {
    await uninstall({ browser: spec.browser, buildId: old.buildId, cacheDir: dir });
  }
  return { flavor, buildId, executablePath: fresh.executablePath };
}

/**
 * Bring a flavor's managed install to latest (the `aiui chrome install` /
 * `update` implementation). Unlike the launch path this resolves with no
 * timeout — an explicit command is allowed to wait on the network — and
 * reports what it did.
 */
export async function ensureLatestManaged(
  flavor: ManagedFlavor,
  report: (line: string) => void,
): Promise<ManagedInstall & { outcome: "current" | "installed" | "updated" }> {
  const spec = flavorSpec(flavor);
  const platform = detectBrowserPlatform();
  if (!platform) {
    throw new Error(`could not detect a supported platform for ${spec.displayName}`);
  }
  const latest = await resolveBuildId(spec.browser, platform, spec.latestTag);
  writeManagedState(flavor, { checkedAt: Date.now(), latestBuildId: latest });
  const current = await installedManaged(flavor);
  if (current && compareBuildIds(current.buildId, latest) >= 0) {
    report(`${spec.displayName} ${current.buildId} is up to date`);
    return { ...current, outcome: "current" };
  }
  report(
    current
      ? `updating ${spec.displayName} ${current.buildId} → ${latest}…`
      : `installing ${spec.displayName} ${latest}…`,
  );
  const fresh = await installManaged(flavor, latest);
  report(`${spec.displayName} ${latest} installed at ${fresh.executablePath}`);
  return { ...fresh, outcome: current ? "updated" : "installed" };
}

/**
 * The launch-path managed-browser sync: decide which browser this session
 * should use, and (interactively, when allowed) offer to install or update the
 * managed build for `flavor`.
 *
 * Returns the executable path to prefer, or undefined to fall back to the
 * system Chrome. Callers only invoke this when config names no browser
 * explicitly (no `chrome.executablePath` / `chrome.channel`).
 *
 * The mode ladder (`chrome.manage`, default "prompt"):
 *  - "off"    — never check, never prompt; an already-installed managed build is
 *               still used (install one deliberately with `aiui chrome install`).
 *  - "auto"   — install/update to latest without asking.
 *  - "prompt" — offer to install when missing, offer to update when stale;
 *               answers can rewrite the mode in the user config.
 *
 * Nothing here ever blocks a non-interactive session: without a TTY (or under
 * CI, or in print mode) this degrades to "use whatever is already installed".
 * Downloads are likewise interactive-only — even "auto" won't pull ~150 MB
 * into a headless one-shot.
 */
export async function syncManagedBrowser(opts: {
  flavor: ManagedFlavor;
  mode: ManageMode;
  interactive: boolean;
  now?: number;
}): Promise<string | undefined> {
  const { flavor, mode, interactive, now = Date.now() } = opts;
  const current = await installedManaged(flavor);
  if (mode === "off" || !interactive) {
    return current?.executablePath;
  }

  if (!current) {
    return offerInstall(flavor, mode, now);
  }

  const latest = await latestManaged(flavor, { now });
  if (!latest || compareBuildIds(latest, current.buildId) <= 0) {
    return current.executablePath;
  }
  return offerUpdate(flavor, mode, current, latest);
}

/** No managed build: install silently (auto) or ask (prompt). */
async function offerInstall(
  flavor: ManagedFlavor,
  mode: "prompt" | "auto",
  now: number,
): Promise<string | undefined> {
  const spec = flavorSpec(flavor);
  const latest = await latestManaged(flavor, { now });
  if (!latest) {
    return undefined; // offline / undetectable platform — don't nag, don't block
  }
  if (mode === "auto") {
    printNote(`installing ${spec.displayName} ${latest} (chrome.manage: "auto")…`);
    return (await installManaged(flavor, latest)).executablePath;
  }
  const state = readManagedState(flavor);
  if (state.installDeclinedAt && now - state.installDeclinedAt < CHECK_TTL_MS) {
    return undefined; // declined recently — don't re-ask every launch
  }
  const answer = await choose(
    `${spec.displayName} isn't installed. It's the recommended browser for aiui — ` +
      "version-pinned, separate from your real Chrome, and it auto-loads the aiui intent " +
      `client (branded Chrome can't). Download ${latest} (~${spec.approxSizeMb} MB) to ` +
      `${managedCacheDir(flavor, false)}?`,
    [
      { key: "y", label: "yes, install it" },
      { key: "n", label: "not now — use the regular Chrome (asks again tomorrow)" },
      { key: "never", label: 'never — stop offering (writes chrome.manage: "off")' },
    ],
    "y",
  );
  if (answer === "y") {
    return (await installManaged(flavor, latest)).executablePath;
  }
  if (answer === "never") {
    const file = updateUserConfig((c) => {
      c.chrome = { ...c.chrome, manage: "off" };
    });
    printNote(`wrote chrome.manage: "off" to ${file}`);
  } else {
    writeManagedState(flavor, { installDeclinedAt: now });
  }
  return undefined;
}

/** Managed build is stale: update silently (auto) or ask (prompt). */
async function offerUpdate(
  flavor: ManagedFlavor,
  mode: "prompt" | "auto",
  current: ManagedInstall,
  latest: string,
): Promise<string> {
  const spec = flavorSpec(flavor);
  if (mode === "auto") {
    printNote(
      `updating ${spec.displayName} ${current.buildId} → ${latest} (chrome.manage: "auto")…`,
    );
    return (await installManaged(flavor, latest)).executablePath;
  }
  if (readManagedState(flavor).skippedBuildId === latest) {
    return current.executablePath;
  }
  const answer = await choose(
    `Your ${spec.displayName} (${current.buildId}) is out of date — latest is ${latest}. Update?`,
    [
      { key: "y", label: "yes, just this once" },
      { key: "a", label: 'automatically, now and from here on (writes chrome.manage: "auto")' },
      {
        key: "s",
        label: `skip ${latest} — keep ${current.buildId}, don't ask again for this version`,
      },
      { key: "never", label: 'never ask again (writes chrome.manage: "off")' },
    ],
    "y",
  );
  switch (answer) {
    case "y":
      return (await installManaged(flavor, latest)).executablePath;
    case "a": {
      const file = updateUserConfig((c) => {
        c.chrome = { ...c.chrome, manage: "auto" };
      });
      printNote(`wrote chrome.manage: "auto" to ${file}`);
      return (await installManaged(flavor, latest)).executablePath;
    }
    case "never": {
      const file = updateUserConfig((c) => {
        c.chrome = { ...c.chrome, manage: "off" };
      });
      printNote(`wrote chrome.manage: "off" to ${file}`);
      return current.executablePath;
    }
    default: // "s"
      writeManagedState(flavor, { skippedBuildId: latest });
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
