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
 * - **Best-effort auto-load of ONE extension: the intent client.** Since the
 *   switchover (owner, 2026-07-14) launches pass exactly the greenfield intent
 *   client's MV3 bundle via `--load-extension` (never building it — see
 *   {@link findIntentClientExtension}). The frozen `aiui-extension` is the
 *   safety net (loaded by hand if ever needed) and the DevTools-panel
 *   extension is a manual install (`aiui chrome extension`) — the intent panel
 *   embeds the same trace debugger now. Chrome-branded builds ≥ 137 ignore the
 *   flag (Chromium and Chrome for Testing still honor it), so this is an
 *   attempt, not a guarantee — the reliable path is loading the extension
 *   unpacked once at `chrome://extensions`, which the persistent profile then
 *   remembers.
 *
 * - **Config picks the browser.** `chrome.executablePath` (e.g. a Chrome for
 *   Testing binary) or `chrome.channel` choose what to launch;
 *   `chrome.browserUrl` says "don't launch anything, attach here" (the remote
 *   key); flags choose per-invocation things (profile, on/off).
 */
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { projectCacheDir } from "@habemus-papadum/aiui-claude-channel";
import { isCi } from "@habemus-papadum/aiui-util";
import { execa } from "execa";
import type { AiuiArgs } from "./aiui-args";
import type { AiuiConfig, ChromeChannel, ChromeMode } from "./config";
import { packageRoot } from "./resolve-cli";
import { printNote, printWarning } from "./ui";

/**
 * The id of the Chrome DevTools entry under `mcpServers`. Deliberately the
 * conventional name from the chrome-devtools-mcp docs: if the user's own Claude
 * config already registers `chrome-devtools`, the two entries collide by name —
 * one definition wins — instead of two MCP servers racing to launch two Chromes
 * with duplicate toolsets.
 */
export const CHROME_SERVER_ID = "chrome-devtools";

const DEVTOOLS_PKG = "@habemus-papadum/aiui-devtools-extension";

/** The FROZEN browser-extension intent tool — the safety net. Not auto-loaded
 * since the switchover (owner, 2026-07-14); `aiui extension` still manages it. */
const INTENT_PKG = "@habemus-papadum/aiui-extension";

/** The greenfield intent client — what launches auto-load now. Its MV3 bundle
 * is a static build (`pnpm -C packages/aiui-intent-client build:ext`). */
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
  /** OBSOLETE since the switchover (2026-07-14): launches no longer auto-load
   * the DevTools extension, so nothing rebuilds it at launch. Parsed and kept
   * so old configs stay valid; `aiui chrome extension` builds on demand. */
  buildExtension: boolean;
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
  return {
    userDataDir: chromeUserDataDir({ dataDir, profile }, base),
    // A configured endpoint means the browser is managed elsewhere (usually
    // another machine) — that's always attach, whatever `mode` says.
    mode: config.browserUrl ? "attach" : (config.mode ?? "attach"),
    browserUrl: config.browserUrl,
    debugPort: config.debugPort ?? 0,
    executablePath: config.executablePath && resolve(base, config.executablePath),
    channel: config.channel,
    headless: config.headless ?? false,
    buildExtension: config.buildExtension ?? true,
  };
}

/**
 * The Chrome user data dir to use (absolute).
 *
 * An explicit `dataDir` wins, resolved against `base`. Otherwise the named
 * profile (default: {@link DEFAULT_CHROME_PROFILE}) maps to
 * `.aiui-cache/chrome/<name>` under `base` — alternate profiles are just other
 * names, created on first use by the caller's mkdir.
 */
export function chromeUserDataDir(
  ids: { dataDir?: string; profile?: string },
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
  return join(projectCacheDir(base), "chrome", profile);
}

/**
 * The built aiui-devtools-extension directory, if available.
 *
 * The package publishes `extension/` prebuilt, so this resolves both in a dev
 * workspace (where `extension/js` appears once built — see
 * {@link buildDevtoolsExtension}) and installed from npm. Without `js/` the
 * extension is an empty shell, so an unbuilt dev checkout returns undefined.
 */
export function devtoolsExtensionDir(): string | undefined {
  let dir: string;
  try {
    // realpath, not the pnpm symlink — the same canonical path a manual
    // "Load unpacked" would register in the profile.
    dir = realpathSync(join(packageRoot(DEVTOOLS_PKG), "extension"));
  } catch {
    return undefined;
  }
  return existsSync(join(dir, "js")) ? dir : undefined;
}

/**
 * The intent extension has **two artifacts, in two directories** (the kit's
 * `webextConfig`, since 2026-07-12):
 *
 * - `dist-dev/` — what `vite` (dev) writes: CRXJS loader stubs that are inert
 *   without the extension's Vite dev server on its pinned port.
 * - `dist/` — what `vite build` writes: the standalone extension, no server
 *   needed. This is also what ships (`files: ["dist"]`).
 *
 * They used to be one directory, which is why a `pnpm build` could silently
 * freeze a live dev install (CONTINUITY trap 1) — and why a launcher could
 * load "the extension" with no idea which of the two it was getting.
 */
export const INTENT_DEV_DIR = "dist-dev";
export const INTENT_OUT_DIR = "dist";

/**
 * Written by the dev build as its LAST act (kit: `aiui-webext/src/dev-stamp`),
 * so its presence means "this dev artifact is complete", and its `runId` says
 * *which dev-server run* wrote it. Duplicated here rather than importing the
 * kit: the CLI has no business depending on CRXJS + the Solid plugin.
 */
const DEV_STAMP_FILE = "aiui-dev.json";

/** The dev artifact's self-description — see the kit's `DevStamp`. */
export interface IntentDevStamp {
  runId: string;
  origin: string;
  port: number;
  startedAt: string;
}

/**
 * What we found when looking for the browser-extension intent tool
 * (`aiui-extension`):
 *
 * - **absent** — the package isn't resolvable here (a plain npm install of the
 *   CLI without it). Silently not our problem.
 * - **unbuilt** — resolvable, but neither artifact exists: a dev checkout where
 *   neither `aiui extension dev` nor `pnpm build` has ever run. Worth a note.
 * - **ready** — a loadable unpacked extension, and *which kind*: `mode: "dev"`
 *   (needs its dev server — `devServer` says whether one is actually answering)
 *   or `mode: "prod"` (self-contained).
 */
export type IntentExtension =
  | { state: "absent" }
  | { state: "unbuilt"; root: string }
  | {
      state: "ready";
      dir: string;
      mode: "dev" | "prod";
      /** dev only: the port its loader stubs dial. */
      devPort?: number;
      /** dev only: is anything actually serving that port right now? */
      devServer?: boolean;
      /** dev only: the run that wrote this artifact, when it stamped itself. */
      stamp?: IntentDevStamp;
      /** A `dist/` still holding a dev-shaped artifact from the old layout. */
      legacyDevDist?: string;
    };

/** Absolute paths for the intent extension's two artifacts, in a checkout. */
export function intentExtensionPaths():
  | { root: string; devDir: string; outDir: string }
  | undefined {
  try {
    // realpath, not the pnpm symlink — the same canonical path a manual
    // "Load unpacked" would register in the profile.
    const root = realpathSync(packageRoot(INTENT_PKG));
    return { root, devDir: join(root, INTENT_DEV_DIR), outDir: join(root, INTENT_OUT_DIR) };
  } catch {
    return undefined;
  }
}

/** The intent client's MV3 bundle directory name (see its build-ext.ts: a
 * THIRD shape of that package — dist/ is the library, dist-ext/ the unpacked
 * extension). */
export const INTENT_CLIENT_OUT_DIR = "dist-ext";

/**
 * What we found when looking for the greenfield intent client's extension —
 * the one launches AUTO-LOAD (the frozen `aiui-extension` retired to
 * safety-net status at the switchover; `aiui extension` still manages it, but
 * no launcher loads it).
 *
 * Deliberately simpler than {@link IntentExtension}: the bundle is a static
 * build with no dev server and no dev/prod split — the client's hot-iteration
 * surface is the channel-served plain page, so the extension only ever needs
 * to be BUILT.
 */
export type IntentClientExtension =
  | { state: "absent" }
  | { state: "unbuilt"; root: string }
  | { state: "ready"; dir: string };

/** Absolute paths for the intent client's bundle, in a checkout. */
export function intentClientExtensionPaths(): { root: string; outDir: string } | undefined {
  try {
    // realpath for the same reason as above: the canonical load-unpacked path.
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
 * launch (the same rule as the frozen extension's ladder): the bundle is a
 * deliberate act — `pnpm -C packages/aiui-intent-client build:ext`. */
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
 * Decide which artifact this launch should load, never building either.
 *
 * Deliberately no build-on-launch here (unlike {@link buildDevtoolsExtension}):
 * whoever owns the dev loop owns `dist-dev/`, and `dist/` is a release
 * decision. The ordering rule, most-live first:
 *
 *  1. a dev artifact whose dev server is **answering** — you are developing the
 *     extension, so that is what you mean;
 *  2. otherwise the production build, if there is one — a stale `dist-dev/`
 *     from last week can never hijack a launch;
 *  3. otherwise the dev artifact anyway, with a loud warning (it will show the
 *     CRXJS "cannot connect" page until you start the server — visibly broken,
 *     which is the point);
 *  4. otherwise: unbuilt.
 */
export async function findIntentExtension(
  probe: (port: number) => Promise<boolean> = devServerAlive,
  prefer: IntentPreference = "auto",
): Promise<IntentExtension> {
  const paths = intentExtensionPaths();
  return paths ? await resolveIntentExtension(paths, probe, prefer) : { state: "absent" };
}

/**
 * Which artifact to load. "auto" is the ladder below; the explicit values are
 * the escape hatches — above all `"prod"`, which is how you run the standalone
 * build *while* a dev server happens to be up (`aiui extension reload --prod`).
 */
export type IntentPreference = "auto" | "dev" | "prod";

/** {@link findIntentExtension}'s decision table, against explicit paths. */
export async function resolveIntentExtension(
  paths: { root: string; devDir: string; outDir: string },
  probe: (port: number) => Promise<boolean> = devServerAlive,
  prefer: IntentPreference = "auto",
): Promise<IntentExtension> {
  const dev = readArtifact(paths.devDir);
  const out = readArtifact(paths.outDir);

  // `dist/` with dev-shaped loader stubs is the pre-split layout (or a `pnpm
  // dev` from an old checkout): it is a dev artifact wearing the release
  // directory's name, and must not be mistaken for a production build.
  const legacy = out?.devPort !== undefined ? out : undefined;
  const release = out && out.devPort === undefined ? out : undefined;
  const candidate = dev ?? legacy;
  const common = { legacyDevDist: legacy?.dir };

  // The escape hatches: "give me the standalone build even though Vite is up"
  // (the production path, and the way to stop a dev loop from re-claiming the
  // browser), and its mirror image.
  if (prefer === "prod" && release) {
    return { state: "ready", dir: release.dir, mode: "prod", ...common };
  }
  if (prefer === "dev" && candidate?.devPort !== undefined) {
    return {
      state: "ready",
      dir: candidate.dir,
      mode: "dev",
      devPort: candidate.devPort,
      devServer: await probe(candidate.devPort),
      stamp: candidate.stamp,
      ...common,
    };
  }

  if (candidate?.devPort !== undefined && (await probe(candidate.devPort))) {
    return {
      state: "ready",
      dir: candidate.dir,
      mode: "dev",
      devPort: candidate.devPort,
      devServer: true,
      stamp: candidate.stamp,
      ...common,
    };
  }
  if (release) {
    return { state: "ready", dir: release.dir, mode: "prod", ...common };
  }
  if (candidate) {
    return {
      state: "ready",
      dir: candidate.dir,
      mode: "dev",
      devPort: candidate.devPort,
      devServer: false,
      stamp: candidate.stamp,
      ...common,
    };
  }
  return { state: "unbuilt", root: paths.root };
}

/** A loadable artifact at `dir`, and whether it is dev-shaped. */
function readArtifact(
  dir: string,
): { dir: string; devPort?: number; stamp?: IntentDevStamp } | undefined {
  if (!existsSync(join(dir, "manifest.json"))) {
    return undefined;
  }
  const stamp = readDevStamp(dir);
  return { dir, devPort: stamp?.port ?? intentExtensionDevPort(dir), stamp };
}

/** The dev artifact's completeness stamp, if it finished writing itself. */
export function readDevStamp(dir: string): IntentDevStamp | undefined {
  try {
    const stamp = JSON.parse(readFileSync(join(dir, DEV_STAMP_FILE), "utf8")) as IntentDevStamp;
    return typeof stamp.runId === "string" && typeof stamp.port === "number" ? stamp : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The dev-server port a dev-shaped artifact depends on, or undefined for a
 * production build. The fingerprint: CRXJS's dev `service-worker-loader.js`
 * imports from `http://localhost:<port>/…`, while a production build's
 * imports are relative. (The stamp says the same thing more directly; this
 * still answers for a half-written artifact, and for the pre-split `dist/`.)
 */
export function intentExtensionDevPort(dir: string): number | undefined {
  let loader: string;
  try {
    loader = readFileSync(join(dir, "service-worker-loader.js"), "utf8");
  } catch {
    return undefined;
  }
  const match = loader.match(/https?:\/\/(?:localhost|127\.0\.0\.1):(\d+)\//);
  return match ? Number(match[1]) : undefined;
}

/** Is the extension's Vite dev server answering on this port? */
export async function devServerAlive(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://localhost:${port}/@vite/client`, {
      signal: AbortSignal.timeout(1000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Rebuild the aiui-devtools-extension package so the auto-loaded panel is never stale.
 *
 * A full tsc of the extension (plus the debug-ui esbuild bundle) is well
 * under a second — cheap enough to run on every launch rather than tracking
 * staleness. Best-effort by design: outside a dev
 * checkout (no devtools package, no typescript) it silently does nothing, and
 * a failing compile warns loudly but never blocks the launch — whatever
 * `extension/js` already holds is what gets loaded.
 */
export async function buildDevtoolsExtension(): Promise<void> {
  let root: string;
  let tsc: string;
  try {
    root = realpathSync(packageRoot(DEVTOOLS_PKG));
    tsc = join(packageRoot("typescript"), "bin", "tsc");
  } catch {
    return;
  }
  // Only a dev checkout carries src/ — the published package ships the built
  // extension/js (no sources, nothing to compile), so installed-from-npm
  // layouts skip straight to loading it.
  if (!existsSync(join(root, "src"))) {
    return;
  }
  const result = await execa(process.execPath, [tsc, "-p", join(root, "tsconfig.json")], {
    cwd: root,
    reject: false,
    all: true,
  });
  if (result.exitCode) {
    printWarning(
      "aiui-devtools-extension failed to compile — the DevTools panel will be stale or missing",
      result.all || result.message,
    );
    return;
  }
  // The Intent pane's shared debug-ui is bundled (esbuild) from the overlay's
  // source — tsc alone can't produce it. Same best-effort posture: the script
  // is only present in a dev checkout, and a failure degrades exactly one pane
  // (the panel imports debug-ui.js lazily), never the launch.
  const bundleScript = join(root, "build-debug-ui.mjs");
  if (!existsSync(bundleScript)) {
    return;
  }
  const bundle = await execa(process.execPath, [bundleScript], {
    cwd: root,
    reject: false,
    all: true,
  });
  if (bundle.exitCode) {
    printWarning(
      "aiui-devtools-extension debug-ui bundle failed — the Intent pane will be degraded",
      bundle.all || bundle.message,
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
  const marker = join(settings.userDataDir, "aiui-devtools-extension-hint");
  if (existsSync(marker)) {
    return;
  }
  printNote(
    "the aiui extensions can't auto-load into regular Chrome (≥ 137 ignores --load-extension)",
    `Load them once in the launched Chrome — chrome://extensions → Developer mode → Load unpacked →\n` +
      `${extensionDirs.join("\n")}\n` +
      "— and this profile remembers them. Or switch to Chrome for Testing (`aiui chrome install`),\n" +
      "which auto-loads them. This note won't repeat for this profile.",
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
