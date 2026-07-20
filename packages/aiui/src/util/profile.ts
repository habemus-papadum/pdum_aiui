/**
 * Browser profiles — the unit of browser identity
 * (docs/proposals/browser-profiles.md).
 *
 * A profile is a Chrome user-data directory under the USER cache
 * (`~/.cache/aiui/userdata/<name>`; the profile named "default" is the
 * default), carrying an immutable marker file that names its browser. Launches
 * specify only a profile (or an explicit `--data-dir`); the browser follows —
 * nothing else gets to pick a binary. Distinct browser builds must never share
 * a user-data dir (Chrome refuses or silently migrates state), which is why
 * the marker is written at creation and never changed: "switch this profile's
 * browser" is answered with "create a new profile".
 *
 * All sessions share the default profile — concurrent `aiui claude` runs in
 * different projects co-drive one browser window, `aiui remote` included.
 * Isolation, when wanted, is a NAMED profile (`aiui profile new`), not a
 * per-project mechanism.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cacheDir } from "@habemus-papadum/aiui-util";
import {
  CHROME_CHANNELS,
  type ChromeChannel,
  DEFAULT_MANAGED_FLAVOR,
  MANAGED_FLAVORS,
  type ManagedFlavor,
} from "./config-schema";
import { type Choice, choose } from "./prompt";

/** The marker's filename inside a profile's user-data dir. */
export const PROFILE_MARKER = "aiui-profile.json";

/** The profile used when no `--profile` names another. */
export const DEFAULT_PROFILE = "default";

/** The cache namespace profiles live under (`~/.cache/aiui/userdata`). */
const USERDATA_NAMESPACE = "userdata";

/** Lowercase slugs only — profile names are directory names and CLI words. */
const PROFILE_NAME = /^[a-z0-9][a-z0-9-]*$/;

/** Exactly one way to pick the browser, mirroring the old config trichotomy. */
export type ProfileBrowser =
  | { managed: ManagedFlavor }
  | { channel: ChromeChannel }
  | { executablePath: string };

/** The on-disk marker (`aiui-profile.json`) — written at creation, immutable. */
export interface ProfileMarker {
  schema: 1;
  browser: ProfileBrowser;
  createdAt: string;
}

/** The directory holding every profile. */
export function profilesRoot(options: { create?: boolean } = {}): string {
  return cacheDir(USERDATA_NAMESPACE, options);
}

/** Validate a profile name (throws with the rule spelled out). */
export function validateProfileName(name: string): string {
  if (!PROFILE_NAME.test(name)) {
    throw new Error(
      `invalid profile name "${name}" — lowercase letters, digits, and "-" only ` +
        "(or use --data-dir for an arbitrary path)",
    );
  }
  return name;
}

/** Absolute user-data dir for a profile name (no mkdir). */
export function profileDir(name: string = DEFAULT_PROFILE): string {
  return join(profilesRoot({ create: false }), validateProfileName(name));
}

/** Parse/validate a marker's browser value; undefined for anything malformed. */
export function parseProfileBrowser(value: unknown): ProfileBrowser | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const b = value as Record<string, unknown>;
  if (typeof b.managed === "string" && (MANAGED_FLAVORS as readonly string[]).includes(b.managed)) {
    return { managed: b.managed as ManagedFlavor };
  }
  if (typeof b.channel === "string" && (CHROME_CHANNELS as readonly string[]).includes(b.channel)) {
    return { channel: b.channel as ChromeChannel };
  }
  if (typeof b.executablePath === "string" && b.executablePath.length > 0) {
    return { executablePath: b.executablePath };
  }
  return undefined;
}

/** Read a dir's marker. Missing or malformed → undefined (callers decide). */
export function readProfileMarker(dir: string): ProfileMarker | undefined {
  let raw: string;
  try {
    raw = readFileSync(join(dir, PROFILE_MARKER), "utf8");
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const m = parsed as Record<string, unknown>;
  const browser = parseProfileBrowser(m.browser);
  if (m.schema !== 1 || browser === undefined || typeof m.createdAt !== "string") {
    return undefined;
  }
  return { schema: 1, browser, createdAt: m.createdAt };
}

/** Write a fresh marker (mkdir as needed). Refuses to overwrite — immutable. */
export function writeProfileMarker(dir: string, browser: ProfileBrowser): ProfileMarker {
  if (readProfileMarker(dir) !== undefined) {
    throw new Error(
      `${join(dir, PROFILE_MARKER)} already exists — a profile's browser is immutable; ` +
        "create a new profile instead",
    );
  }
  const marker: ProfileMarker = { schema: 1, browser, createdAt: new Date().toISOString() };
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, PROFILE_MARKER), `${JSON.stringify(marker, null, 2)}\n`);
  return marker;
}

/** A dir that is absent or empty is claimable as a new profile. */
export function isClaimableProfileDir(dir: string): boolean {
  try {
    return readdirSync(dir).length === 0;
  } catch {
    return !existsSync(dir);
  }
}

/** Human label for a marker's browser ("chromium (managed)", "chrome beta", …). */
export function profileBrowserLabel(browser: ProfileBrowser): string {
  if ("managed" in browser) {
    return `${browser.managed} (managed)`;
  }
  if ("channel" in browser) {
    return `chrome ${browser.channel}`;
  }
  return browser.executablePath;
}

/** Injectable for tests; matches {@link choose} without a default key. */
type Ask = (question: string, choices: Choice[]) => Promise<string>;

const BROWSER_QUESTION = (profile: string): string =>
  `One-time setup — which browser should the "${profile}" profile use?\n` +
  "aiui downloads and manages the browser for you (version-pinned, separate from your real\n" +
  "Chrome, auto-loads the intent client's extension). Chromium's open-source build dodges the\n" +
  '"verify you\'re human" reCAPTCHA Google serves to the Chrome-for-Testing automation build,\n' +
  "at the cost of Widevine/DRM and Google-account sign-in. Recorded in the profile itself\n" +
  `(${PROFILE_MARKER}) — immutable; a different browser is a different profile\n` +
  "(advanced choices — a branded Chrome channel or an explicit binary — via `aiui profile new`).";

/**
 * Make sure `dir` is a real profile: return its marker, creating one when the
 * dir is claimable (interview when `interactive`, silent Chromium default
 * otherwise — the same default the old config gave). A NON-empty dir without a
 * marker is foreign: refuse to guess a binary against unknown profile data.
 */
export async function ensureProfileMarker(
  dir: string,
  opts: { interactive: boolean; profileName?: string; ask?: Ask },
): Promise<ProfileMarker> {
  const existing = readProfileMarker(dir);
  if (existing) {
    return existing;
  }
  if (!isClaimableProfileDir(dir)) {
    throw new Error(
      `${dir} exists but has no ${PROFILE_MARKER} — refusing to guess which browser owns it.\n` +
        "Adopt it explicitly:  aiui profile adopt <name> --chromium (or --cft | --channel | --executable)",
    );
  }
  let browser: ProfileBrowser = { managed: DEFAULT_MANAGED_FLAVOR };
  if (opts.interactive) {
    const ask = opts.ask ?? choose;
    const answer = await ask(BROWSER_QUESTION(opts.profileName ?? dir), [
      { key: "c", label: "Chromium (recommended)" },
      { key: "t", label: "Chrome for Testing" },
    ]);
    browser = { managed: answer === "t" ? "chrome-for-testing" : "chromium" };
  }
  return writeProfileMarker(dir, browser);
}
