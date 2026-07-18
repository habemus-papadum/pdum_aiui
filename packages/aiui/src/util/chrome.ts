/**
 * The Chrome DevTools MCP attachment for `aiui claude`.
 *
 * By default the session gets a second MCP server alongside the channel:
 * Google's [chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp),
 * run via npx, giving the agent a Chrome to drive (navigate, click, screenshot,
 * evaluate). It reaches a browser one of two ways — the mode ladder itself
 * lives in commands/claude.ts (chromeServerEntry); the full user-facing story
 * is docs/guide/chrome:
 *
 * - **attach** (default): the MCP is pointed (`--browser-url`) at a shared,
 *   user-visible *session browser* — discovered or eagerly launched via
 *   aiui-util's browser module — so human and agent work in the same window.
 * - **launch**: the MCP launches its own private browser, lazily, on the
 *   agent's first tool call ({@link chromeMcpServer} builds that entry).
 *
 * The deliberate choices common to both:
 *
 * - **A persistent, project-local profile.** Chrome's user data dir defaults to
 *   `.aiui-cache/chrome/default` under the launch directory — the same
 *   gitignored cache the lowering traces live in — so browser state (logins,
 *   devtools settings, manually installed extensions) survives across sessions
 *   and stays out of both git and the user's real browser profile. Named
 *   profiles (`--aiui-chrome-profile <name>`) live as siblings and are created
 *   on first use; `--aiui-chrome-data-dir <path>` escapes the convention
 *   entirely.
 *
 * - **Best-effort auto-load of ONE extension: the intent client.** Launches
 *   pass exactly the intent client's MV3 bundle via `--load-extension` (never
 *   building it — see {@link findIntentClientExtension}). Chrome-branded
 *   builds ≥ 137 ignore the flag (Chromium and Chrome for Testing still honor
 *   it), so this is an attempt, not a guarantee — the reliable path is loading
 *   the extension unpacked once at `chrome://extensions`, which the persistent
 *   profile then remembers.
 *
 * - **Config picks the browser.** `chrome.executablePath` (e.g. a Chrome for
 *   Testing binary) or `chrome.channel` choose what to launch;
 *   `chrome.browserUrl` says "don't launch anything, attach here" (the remote
 *   key); flags choose per-invocation things (profile, on/off).
 */
import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { projectCacheDir } from "@habemus-papadum/aiui-claude-channel";
import { isCi } from "@habemus-papadum/aiui-util";
import type { AiuiArgs } from "./aiui-args";
import type { AiuiConfig, ChromeChannel, ChromeMode } from "./config";
import { DEFAULT_MANAGED_FLAVOR, resolveManagedFlavor } from "./config";
import { packageRoot } from "./resolve-cli";
import { printNote } from "./ui";

/**
 * The id of the Chrome DevTools entry under `mcpServers`. Deliberately the
 * conventional name from the chrome-devtools-mcp docs: if the user's own Claude
 * config already registers `chrome-devtools`, the two entries collide by name —
 * one definition wins — instead of two MCP servers racing to launch two Chromes
 * with duplicate toolsets.
 */
export const CHROME_SERVER_ID = "chrome-devtools";

/** The intent client — what launches auto-load. Its MV3 bundle is a static
 * build (`pnpm -C packages/aiui-intent-client build:ext`). */
const INTENT_CLIENT_PKG = "@habemus-papadum/aiui-intent-client";

/** The profile used when neither flags nor config name one. */
export const DEFAULT_CHROME_PROFILE = "default";

/** Profile names must stay plain directory names — no separators, no leading dot. */
const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

type ChromeConfig = NonNullable<AiuiConfig["chrome"]>;
type ChromeFlags = Pick<AiuiArgs, "chrome" | "noChrome" | "chromeProfile" | "chromeDataDir">;

/**
 * Whether this launch should attach the Chrome DevTools MCP.
 *
 * On by default; off under CI (no display, and e2e sessions must not trigger an
 * npx download + Chrome launch), with `--aiui-no-chrome`, or with
 * `chrome.enabled: false` in config. `--aiui-chrome` forces it on even under
 * CI; `chrome.enabled: true` merely restates the default and does not.
 *
 * Deliberately gated on CI alone, not the wider `isHeadless` check from
 * aiui-util: on a headless-but-interactive box (SSH into a dev machine)
 * the MCP still works — it just launches/attaches a headless-capable Chrome —
 * whereas *opening a page for the user* would be pointless. Only commands that
 * put a window in front of someone consult the broader signals.
 */
export function chromeDevtoolsEnabled(
  args: Pick<ChromeFlags, "chrome" | "noChrome">,
  config: ChromeConfig = {},
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (args.noChrome) {
    return false;
  }
  if (args.chrome) {
    return true;
  }
  if (config.enabled === false) {
    return false;
  }
  return !isCi(env);
}

/** The launch-relevant Chrome settings after flags and config are reconciled. */
export interface ChromeSettings {
  /** Absolute user data dir for this launch. */
  userDataDir: string;
  /**
   * The browser-variant tag the profile is partitioned under (see
   * {@link chromeVariant}) — `chromium`, `chrome-for-testing`, `chrome-<channel>`,
   * or `custom-<hash>`. Informational; `custom-*` when an explicit `dataDir`
   * escapes the convention.
   */
  variant: string;
  /**
   * "attach" (default): share a session browser — discover or eagerly launch
   * one and point the MCP at its debug endpoint. "launch": chrome-devtools-mcp
   * owns a private browser, started lazily on first tool use.
   */
  mode: ChromeMode;
  /** Explicit attach endpoint from config; forces attach, disables management. */
  browserUrl?: string;
  /** Debug port for session browsers aiui launches (0 = OS-assigned). */
  debugPort: number;
  /** Chrome binary to launch instead of an installed channel, if configured. */
  executablePath?: string;
  /** Installed Chrome release channel to launch, if configured. */
  channel?: ChromeChannel;
  headless: boolean;
}

/**
 * Reconcile CLI flags with config into the settings for this launch.
 *
 * Flags beat config. The profile/data-dir pair is reconciled as a unit: a
 * `--aiui-chrome-profile` flag also suppresses a configured `dataDir` (and
 * vice versa), because whichever identity the user named at the prompt is the
 * one they mean. Within config alone, `dataDir` beats `profile`.
 */
export function resolveChromeSettings(
  args: Pick<ChromeFlags, "chromeProfile" | "chromeDataDir">,
  config: ChromeConfig = {},
  base: string = process.cwd(),
): ChromeSettings {
  if (config.executablePath && config.channel) {
    throw new Error(
      "config sets both chrome.executablePath and chrome.channel — they pick the browser " +
        "two different ways; keep exactly one",
    );
  }
  const flagged = args.chromeProfile !== undefined || args.chromeDataDir !== undefined;
  const dataDir = args.chromeDataDir ?? (flagged ? undefined : config.dataDir);
  const profile = args.chromeProfile ?? (flagged ? undefined : config.profile);
  // The variant is derived from the config's *declared* browser intent (channel
  // / explicit executablePath / managed flavor), NOT from an executablePath the
  // launch path later injects for the managed flavor — so a managed Chromium
  // and a managed CfT keep distinct profiles, and injecting the resolved binary
  // never moves the profile out from under a running session. Callers patch
  // `executablePath` post-sync; they must not re-derive the data dir.
  const variant = chromeVariant(config);
  return {
    userDataDir: chromeUserDataDir({ dataDir, profile, variant }, base),
    variant,
    // A configured endpoint means the browser is managed elsewhere (usually
    // another machine) — that's always attach, whatever `mode` says.
    mode: config.browserUrl ? "attach" : (config.mode ?? "attach"),
    browserUrl: config.browserUrl,
    debugPort: config.debugPort ?? 0,
    executablePath: config.executablePath && resolve(base, config.executablePath),
    channel: config.channel,
    headless: config.headless ?? false,
  };
}

/**
 * The variant tag a launch's profile is partitioned under. Distinct browser
 * builds must not share a Chrome user data dir — a downgrade or a
 * different-channel launch on the same profile can refuse to start ("profile
 * was created by a newer version") or silently migrate state — so each variant
 * gets its own directory:
 *
 *  - an explicit `channel` → `chrome-<channel>` (e.g. `chrome-beta`)
 *  - an explicit `executablePath` → `custom-<hash>` (stable per binary path, so
 *    two hand-picked binaries don't collide)
 *  - otherwise the managed flavor → `chromium` or `chrome-for-testing`
 *
 * `channel` and `executablePath` are mutually exclusive (validated in
 * {@link resolveChromeSettings}); channel is checked first only for definiteness.
 */
export function chromeVariant(
  config: Pick<ChromeConfig, "channel" | "executablePath" | "managed">,
): string {
  if (config.channel) {
    return `chrome-${config.channel}`;
  }
  if (config.executablePath) {
    return `custom-${executablePathHash(config.executablePath)}`;
  }
  return resolveManagedFlavor(config);
}

/** A short, stable, filesystem-safe hash of a binary path (djb2, base36). */
function executablePathHash(path: string): string {
  let hash = 5381;
  for (let i = 0; i < path.length; i++) {
    hash = ((hash * 33) ^ path.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36);
}

/**
 * The Chrome user data dir to use (absolute).
 *
 * An explicit `dataDir` wins, resolved against `base`. Otherwise the named
 * profile (default: {@link DEFAULT_CHROME_PROFILE}) maps to
 * `.aiui-cache/chrome/<variant>/<name>` under `base`, partitioned by browser
 * variant (see {@link chromeVariant}) so distinct builds never share a profile.
 * Alternate profiles are just other names, created on first use by the caller's
 * mkdir; `variant` defaults to {@link DEFAULT_MANAGED_FLAVOR}.
 */
export function chromeUserDataDir(
  ids: { dataDir?: string; profile?: string; variant?: string },
  base: string = process.cwd(),
): string {
  if (ids.dataDir) {
    return resolve(base, ids.dataDir);
  }
  const profile = ids.profile ?? DEFAULT_CHROME_PROFILE;
  if (!PROFILE_NAME.test(profile)) {
    throw new Error(
      `invalid chrome profile name "${profile}" — use letters, digits, ".", "_", "-" ` +
        "(or --aiui-chrome-data-dir for an arbitrary path)",
    );
  }
  const variant = ids.variant ?? DEFAULT_MANAGED_FLAVOR;
  return join(projectCacheDir(base), "chrome", variant, profile);
}

/** The intent client's MV3 bundle directory name (see its build-ext.ts: a
 * THIRD shape of that package — dist/ is the library, dist-ext/ the unpacked
 * extension). */
export const INTENT_CLIENT_OUT_DIR = "dist-ext";

/**
 * What we found when looking for the intent client's extension — the one
 * launches AUTO-LOAD.
 *
 * Deliberately simple: the bundle is a static build with no dev server and no
 * dev/prod split — the client's hot-iteration surface is the channel-served
 * plain page, so the extension only ever needs to be BUILT.
 */
export type IntentClientExtension =
  | { state: "absent" }
  | { state: "unbuilt"; root: string }
  | { state: "ready"; dir: string };

/** Absolute paths for the intent client's bundle, in a checkout. */
export function intentClientExtensionPaths(): { root: string; outDir: string } | undefined {
  try {
    // realpath, not the pnpm symlink — the same canonical path a manual
    // "Load unpacked" would register in the profile.
    const root = realpathSync(packageRoot(INTENT_CLIENT_PKG));
    return { root, outDir: join(root, INTENT_CLIENT_OUT_DIR) };
  } catch {
    return undefined;
  }
}

/** {@link findIntentClientExtension}'s decision, against explicit paths. */
export function resolveIntentClientExtension(
  paths: { root: string; outDir: string } | undefined,
): IntentClientExtension {
  if (paths === undefined) {
    return { state: "absent" };
  }
  return existsSync(join(paths.outDir, "manifest.json"))
    ? { state: "ready", dir: paths.outDir }
    : { state: "unbuilt", root: paths.root };
}

/** The intent client extension, as this checkout can load it. No build-on-
 * launch: the bundle is a deliberate act —
 * `pnpm -C packages/aiui-intent-client build:ext`. */
export function findIntentClientExtension(): IntentClientExtension {
  return resolveIntentClientExtension(intentClientExtensionPaths());
}

/** One launch-time note when the client is resolvable but unbuilt — printed
 * every launch while true (actionable; it disappears once fixed). */
export function warnIntentClientState(intent: IntentClientExtension): void {
  if (intent.state === "unbuilt") {
    printNote(
      "the aiui intent client has no MV3 bundle yet, so this launch won't load it",
      "Build it once:  pnpm -C packages/aiui-intent-client build:ext\n" +
        "then relaunch — or load it into the RUNNING browser:\n" +
        "  pnpm -C packages/aiui-intent-client ext",
    );
  }
}

/**
 * One-time tip when extensions exist but the chosen browser won't
 * auto-load them (no `executablePath` means a branded Chrome — installed
 * stable or a `channel` build — and branded builds ≥ 137 ignore
 * `--load-extension`). Printed once per profile: the marker file lives in the
 * user data dir, so it survives exactly as long as the profile whose manual
 * install it recommends.
 */
export function maybeExtensionAutoloadHint(
  settings: ChromeSettings,
  extensionDirs: string[],
): void {
  if (!extensionDirs.length || settings.executablePath) {
    return;
  }
  const marker = join(settings.userDataDir, "aiui-extension-autoload-hint");
  if (existsSync(marker)) {
    return;
  }
  printNote(
    "the aiui intent client can't auto-load into regular Chrome (≥ 137 ignores --load-extension)",
    `Load it once in the launched Chrome — chrome://extensions → Developer mode → Load unpacked →\n` +
      `${extensionDirs.join("\n")}\n` +
      "— and this profile remembers it. Or use the managed browser (`aiui chrome install`),\n" +
      "which auto-loads it. This note won't repeat for this profile.",
  );
  try {
    writeFileSync(marker, `${new Date().toISOString()}\n`);
  } catch {
    // Best-effort: an unwritable profile dir just means the note may repeat.
  }
}

/**
 * The `mcpServers` entry that launches chrome-devtools-mcp.
 *
 * Uses the documented `npx -y chrome-devtools-mcp@latest` invocation with the
 * user data dir pinned to ours. Puppeteer's default launch args include
 * `--disable-extensions`, which would neuter both the auto-loaded extensions
 * and anything installed manually into the profile — so it is always stripped.
 * When extension dirs are given, additionally ask Chrome to load them.
 */
/**
 * The `mcpServers` entry that *attaches* chrome-devtools-mcp to an existing
 * browser's DevTools endpoint (a session browser, or a tunneled remote one).
 * In this mode the MCP manages no browser: user-data-dir, extension, and
 * headless choices all belong to whoever launched it.
 */
export function chromeMcpAttachServer(browserUrl: string): { command: string; args: string[] } {
  return {
    command: "npx",
    args: ["-y", "chrome-devtools-mcp@latest", "--browser-url", browserUrl],
  };
}

export function chromeMcpServer(
  settings: ChromeSettings,
  extensionDirs: string[] = [],
): { command: string; args: string[] } {
  const args = [
    "-y",
    "chrome-devtools-mcp@latest",
    "--userDataDir",
    settings.userDataDir,
    "--ignoreDefaultChromeArg=--disable-extensions",
  ];
  if (settings.executablePath) {
    args.push("--executablePath", settings.executablePath);
  }
  if (settings.channel) {
    args.push("--channel", settings.channel);
  }
  if (settings.headless) {
    args.push("--headless");
  }
  if (extensionDirs.length) {
    args.push(`--chromeArg=--load-extension=${extensionDirs.join(",")}`);
  }
  return { command: "npx", args };
}
