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
 * - **A persistent, user-level profile — shared across projects.** Chrome's
 *   user data dir is a PROFILE under `~/.cache/aiui/userdata/<name>` (default
 *   "default"; util/profile.ts), so browser state — logins, devtools settings,
 *   manually installed extensions — survives across sessions AND projects,
 *   never touching the user's real browser profile. `--aiui-profile <name>`
 *   picks another; `--aiui-chrome-data-dir <path>` escapes the convention.
 *
 * - **Best-effort auto-load of ONE extension: the intent client.** Launches
 *   pass exactly the intent client's MV3 bundle via `--load-extension` (never
 *   building it — see {@link findIntentClientExtension}). Chrome-branded
 *   builds ≥ 137 ignore the flag (Chromium and Chrome for Testing still honor
 *   it), so this is an attempt, not a guarantee — the reliable path is loading
 *   the extension unpacked once at `chrome://extensions`, which the persistent
 *   profile then remembers.
 *
 * - **The PROFILE picks the browser.** The profile's immutable marker
 *   (aiui-profile.json) names a managed flavor, a branded channel, or an
 *   explicit binary; there is no other browser-selection input
 *   (docs/proposals/browser-profiles.md). `--aiui-browser-url` says "don't
 *   launch anything, attach here" (how `aiui remote`'s printed invocation
 *   works).
 */
import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isCi } from "@habemus-papadum/aiui-util";
import type { AiuiArgs } from "./aiui-args";
import type { AiuiConfig, ChromeChannel } from "./config";
import { type ProfileBrowser, profileDir, readProfileMarker } from "./profile";
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

type ChromeConfig = NonNullable<AiuiConfig["chrome"]>;
type ChromeFlags = Pick<AiuiArgs, "chrome" | "noChrome" | "chromeProfile" | "chromeDataDir">;

/**
 * Whether this launch should attach the Chrome DevTools MCP.
 *
 * On by default; off under CI (no display, and e2e sessions must not trigger an
 * npx download + Chrome launch) or with `--aiui-no-chrome`. `--aiui-chrome`
 * forces it on even under CI. Flag-only since the browser-profiles redesign —
 * the old `chrome.enabled` config key is retired.
 *
 * Deliberately gated on CI alone, not the wider `isHeadless` check from
 * aiui-util: on a headless-but-interactive box (SSH into a dev machine)
 * the MCP still works — it just launches/attaches a headless-capable Chrome —
 * whereas *opening a page for the user* would be pointless. Only commands that
 * put a window in front of someone consult the broader signals.
 */
export function chromeDevtoolsEnabled(
  args: Pick<ChromeFlags, "chrome" | "noChrome">,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (args.noChrome) {
    return false;
  }
  if (args.chrome) {
    return true;
  }
  return !isCi(env);
}

/**
 * The launch-relevant Chrome settings after flags and config are reconciled.
 * The PROFILE picks the browser (docs/proposals/browser-profiles.md): identity
 * comes from the user-data dir's marker, headless from config; there is no
 * other browser-selection input.
 */
export interface ChromeSettings {
  /** Absolute user data dir for this launch. */
  userDataDir: string;
  /**
   * Browser identity from the profile's marker — absent when the profile
   * doesn't exist yet (the launch paths ensure it via
   * `ensureProfileMarker` before picking a binary).
   */
  browser?: ProfileBrowser;
  headless: boolean;
}

/**
 * Reconcile CLI flags with config into the settings for this launch: the
 * profile name (default "default") or an explicit data dir picks the
 * user-data dir; the dir's marker (when present) names the browser.
 */
export function resolveChromeSettings(
  args: Pick<ChromeFlags, "chromeProfile" | "chromeDataDir">,
  config: ChromeConfig = {},
  base: string = process.cwd(),
): ChromeSettings {
  const userDataDir = args.chromeDataDir
    ? resolve(base, args.chromeDataDir)
    : profileDir(args.chromeProfile);
  const marker = readProfileMarker(userDataDir);
  return {
    userDataDir,
    ...(marker !== undefined ? { browser: marker.browser } : {}),
    headless: config.headless ?? false,
  };
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
  // Only a branded Chrome (a `channel` marker) ignores --load-extension; the
  // managed flavors and explicit binaries honor it.
  if (!extensionDirs.length || settings.browser === undefined || !("channel" in settings.browser)) {
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
  launch: {
    userDataDir: string;
    executablePath?: string;
    channel?: ChromeChannel;
    headless?: boolean;
  },
  extensionDirs: string[] = [],
): { command: string; args: string[] } {
  const args = [
    "-y",
    "chrome-devtools-mcp@latest",
    "--userDataDir",
    launch.userDataDir,
    "--ignoreDefaultChromeArg=--disable-extensions",
  ];
  if (launch.executablePath) {
    args.push("--executablePath", launch.executablePath);
  }
  if (launch.channel) {
    args.push("--channel", launch.channel);
  }
  if (launch.headless) {
    args.push("--headless");
  }
  if (extensionDirs.length) {
    args.push(`--chromeArg=--load-extension=${extensionDirs.join(",")}`);
  }
  return { command: "npx", args };
}
