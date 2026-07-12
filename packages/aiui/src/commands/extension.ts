/**
 * `aiui extension` — the browser-extension intent tool's command surface:
 * its dev loop (`dev`, `reload`) and its native side (`install-native-host`,
 * `status`; browser-extension proposal §4 — the native-messaging host lets the
 * extension enumerate channels cold, since the on-disk registry is unreachable
 * from a browser).
 *
 * **The dev loop is a command because the ORDER is the whole game.** The
 * extension's Vite dev server rewrites its `dist-dev/` on every start, and
 * Chrome holds whatever it read last. Two rules, and every blank-panel
 * mystery this repo has had is one of them being broken:
 *
 *  1. Chrome must not read the directory while Vite is writing it (a partial
 *     extension loads with no error — just nothing).
 *  2. Chrome must be told to re-read it after every dev-server start (else it
 *     silently runs the previous run's code).
 *
 * `aiui extension dev` owns both: it starts Vite, waits for the artifact to
 * stamp itself complete (the kit's `aiui-dev.json`), and only then reloads the
 * extension in this project's session browser over CDP. `aiui extension reload`
 * is the same second half on its own — after a `pnpm build`, after a manual
 * `vite`, or any time a surface looks stale.
 *
 * `install-native-host` writes two things, both idempotent:
 *  1. A wrapper script under the user cache that execs this CLI's
 *     `native-host` subcommand with absolute paths (Chrome spawns NM hosts
 *     with a minimal environment and cwd `/` — nothing here may rely on PATH
 *     or working directory; `--import tsx` resolves from cwd, hence the `cd`).
 *  2. The NM manifest into each installed browser's user-level
 *     `NativeMessagingHosts/` directory (macOS + Linux paths; Chrome,
 *     Chromium, Edge). `allowed_origins` pins the extension id — the default
 *     is the stable id derived from the key checked into
 *     `packages/aiui-extension/manifest.config.ts`.
 *
 * That global install covers browsers aiui does NOT manage. The session
 * browsers aiui launches are handled without it: {@link
 * installProfileNativeHost} drops the same manifest into the launch profile's
 * own `<user-data-dir>/NativeMessagingHosts/`, which is where Chrome for
 * Testing actually looks (measured live on macOS, CfT 150: it reads the user
 * data dir, NOT `~/Library/Application Support/Google/ChromeForTesting` or
 * any other Application Support spelling — those were never read). Launchers
 * call it automatically whenever they load the intent extension, so an
 * aiui-launched browser needs no global install at all.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  cacheDir,
  discoverSessionBrowser,
  evaluateInExtension,
  packageRoot,
  type ReloadExtensionResult,
  reloadExtension,
} from "@habemus-papadum/aiui-util";
import { execa } from "execa";
import {
  devServerAlive,
  findIntentExtension,
  type IntentDevStamp,
  intentExtensionPaths,
  readDevStamp,
  resolveChromeSettings,
} from "../util/chrome";
import { loadAiuiConfig } from "../util/config";
import { resolvePackageCli } from "../util/resolve-cli";
import { printError, printNote, printWarning } from "../util/ui";

/** The NM host name (lowercase alphanumerics, dots, underscores only). */
export const NATIVE_HOST_NAME = "com.habemus_papadum.aiui";

/** The stable unpacked-extension id (from the pinned manifest key). */
export const DEFAULT_EXTENSION_ID = "ngakidpkjdgaajnlpggbchpaikilkpmp";

/**
 * An inert page inside the extension, opened in a background tab when the
 * extension has no live context to evaluate `chrome.runtime.reload()` in (an
 * idle MV3 service worker leaves none). Shipped in both artifacts.
 */
const WAKE_PAGE = "reload.html";

export interface ExtensionOptions {
  extensionId?: string;
  /** Named profile under `.aiui-cache/chrome/` (which browser to reload in). */
  profile?: string;
  /** Explicit Chrome user data dir (which browser to reload in). */
  dataDir?: string;
}

/**
 * Browser NM manifest directories, user-level, per platform.
 *
 * Deliberately NO Chrome for Testing entry: CfT does not read a fixed
 * user-level directory — it looks in `<user-data-dir>/NativeMessagingHosts`
 * (measured on macOS; an earlier `Google/ChromeForTesting` guess here was
 * never read by anything). aiui-launched browsers get the manifest written
 * into their profile at launch instead ({@link installProfileNativeHost}).
 */
export function nativeHostManifestDirs(platform: NodeJS.Platform, home: string): string[] {
  if (platform === "darwin") {
    const base = join(home, "Library", "Application Support");
    return [
      join(base, "Google", "Chrome", "NativeMessagingHosts"),
      join(base, "Chromium", "NativeMessagingHosts"),
      join(base, "Microsoft Edge", "NativeMessagingHosts"),
    ];
  }
  if (platform === "linux") {
    return [
      join(home, ".config", "google-chrome", "NativeMessagingHosts"),
      join(home, ".config", "chromium", "NativeMessagingHosts"),
      join(home, ".config", "microsoft-edge", "NativeMessagingHosts"),
    ];
  }
  throw new Error(`aiui extension: unsupported platform ${platform} (macOS/Linux only for now)`);
}

/** The wrapper script body. Exported for tests. */
export function wrapperScript(cwd: string, command: string, args: string[]): string {
  const q = (s: string): string => `"${s.replace(/(["\\$`])/g, "\\$1")}"`;
  return [
    "#!/bin/sh",
    "# aiui native-messaging host wrapper — generated by `aiui extension install-native-host`.",
    "# Chrome spawns this with a minimal env and cwd /; everything below is absolute.",
    `cd ${q(cwd)} || exit 1`,
    `exec ${[command, ...args].map(q).join(" ")} native-host`,
    "",
  ].join("\n");
}

const ACTIONS = ["dev", "reload", "install-native-host", "status"] as const;

export async function runExtension(action: string, options: ExtensionOptions = {}): Promise<void> {
  switch (action) {
    case "dev":
      await runExtensionDev(options);
      return;
    case "reload":
      await runExtensionReload(options);
      return;
    case "install-native-host":
      installNativeHost(options);
      return;
    case "status":
      statusNativeHost();
      return;
    default:
      throw new Error(`aiui extension: unknown action "${action}" (${ACTIONS.join(" | ")})`);
  }
}

/**
 * `aiui extension dev` — the blessed dev loop: Vite, then a reload, in that
 * order, every time.
 *
 * Run it from the *project* whose session browser you're developing against
 * (the same directory you run `aiui claude` from) — that's what picks the
 * profile, exactly like `aiui open` and `aiui browser`. Vite itself always
 * runs in the extension package, wherever that is in the workspace.
 *
 * Vite owns the terminal (stdio inherited: Ctrl-C, its shortcuts, its output);
 * the reload rides alongside, and a browser that isn't running yet is a note,
 * never a failure — the dev server is still the point.
 */
async function runExtensionDev(options: ExtensionOptions): Promise<void> {
  const paths = intentExtensionPaths();
  if (!paths || !existsSync(join(paths.root, "vite.config.ts"))) {
    printError(
      "aiui extension dev needs a source checkout of @habemus-papadum/aiui-extension",
      "The published package ships only its built extension — there is nothing to dev-serve.",
    );
    process.exitCode = 1;
    return;
  }
  const vite = viteBin(paths.root);
  if (!vite) {
    printError(
      `Vite is not installed in ${paths.root}`,
      "Run `pnpm install` at the workspace root.",
    );
    process.exitCode = 1;
    return;
  }

  // Whatever run wrote the current artifact (if any): the reload must wait for
  // a *different* one, or we'd reload Chrome onto the previous run's files.
  const before = readDevStamp(paths.devDir);
  const child = execa(process.execPath, [vite], {
    cwd: paths.root,
    stdio: "inherit",
    reject: false,
  });
  let running = true;
  void child.finally(() => {
    running = false;
  });

  const stamp = await waitForDevArtifact(paths.devDir, before, () => running);
  if (stamp) {
    await reloadIntoSessionBrowser(options);
  } else if (running) {
    printWarning(
      "the extension's dev artifact never stamped itself complete — not reloading the browser",
      "Vite is still running; once it settles, run `aiui extension reload` by hand.",
    );
  }

  const result = await child;
  if (result.exitCode) {
    process.exitCode = result.exitCode;
  }
}

/**
 * `aiui extension reload` — make the session browser re-read the extension's
 * directory. The manual half of the loop: after `pnpm build` (you switched
 * artifacts), after a bare `vite`, or whenever a surface looks stale.
 */
async function runExtensionReload(options: ExtensionOptions): Promise<void> {
  const intent = await findIntentExtension();
  if (intent.state === "absent") {
    printError("the @habemus-papadum/aiui-extension package is not resolvable here");
    process.exitCode = 1;
    return;
  }
  if (intent.state === "unbuilt") {
    printError(
      "the intent extension has no artifact to reload",
      "aiui extension dev   (dev loop)   ·   pnpm -C packages/aiui-extension build   (standalone)",
    );
    process.exitCode = 1;
    return;
  }
  if (intent.mode === "dev") {
    if (!intent.devServer) {
      printWarning(
        `nothing is serving :${intent.devPort}, so the dev artifact will load blank`,
        "Reloading anyway — start `aiui extension dev` and it will reload again for you.",
      );
    } else if (!intent.stamp) {
      // Server up, no stamp: Vite is mid-write. Waiting is the whole point.
      const stamp = await waitForDevArtifact(intent.dir, undefined, () => true, 30_000);
      if (!stamp) {
        printWarning(
          "the dev artifact is still being written — reloading now could cache a partial extension",
          "Wait for the dev server to settle, then rerun `aiui extension reload`.",
        );
        process.exitCode = 1;
        return;
      }
    }
  }
  await reloadIntoSessionBrowser(options);
}

/**
 * Reload the extension in the session browser this directory would use, then
 * **check what the browser is now actually running** by reading the extension's
 * own dev stamp back out of it.
 *
 * That last step is the difference between hoping and knowing, and it catches
 * the one failure the two-directory split introduces: Chrome installs an
 * unpacked extension *by path*, so a browser that was launched (or Load-
 * unpacked'ed) against `dist/` keeps re-reading `dist/` no matter how many
 * times you reload it — the dev server's output never arrives, and every
 * symptom looks exactly like a stale build. The extension tells us which one it
 * is, so we can say so.
 */
async function reloadIntoSessionBrowser(
  options: ExtensionOptions,
): Promise<ReloadExtensionResult | undefined> {
  const intent = await findIntentExtension();
  const dir = intent.state === "ready" ? intent.dir : undefined;
  const what =
    intent.state === "ready"
      ? intent.mode === "dev"
        ? `dev build (${intent.dir})`
        : `production build (${intent.dir})`
      : "extension";

  const config = loadAiuiConfig();
  const settings = resolveChromeSettings(
    { chromeProfile: options.profile, chromeDataDir: options.dataDir },
    config.chrome ?? {},
  );
  const browserUrl =
    config.chrome?.browserUrl ?? (await discoverSessionBrowser(settings.userDataDir))?.browserUrl;
  if (!browserUrl) {
    printNote(
      "no session browser is running for this profile — nothing to reload",
      `Start one with \`aiui browser\` (or \`aiui claude\`) and it will load the ${what}.\n` +
        `(profile: ${settings.userDataDir})`,
    );
    return undefined;
  }

  const extensionId = options.extensionId ?? DEFAULT_EXTENSION_ID;
  // Only offer the wake page if the loaded artifact actually contains it — a
  // missing page would open an error document we'd then "succeed" in.
  const wakePage = dir && existsSync(join(dir, WAKE_PAGE)) ? WAKE_PAGE : undefined;
  const result = await reloadExtension(browserUrl, { extensionId, wakePage });

  if (!result.ok) {
    if (result.reason === "not-loaded") {
      printWarning(
        "the intent extension is not loaded in the session browser — nothing to reload",
        `Load it once: chrome://extensions → Developer mode → Load unpacked → ${dir}\n` +
          "(or relaunch the browser with `aiui browser` — Chrome for Testing auto-loads it).",
      );
    } else {
      printWarning(
        `couldn't reload the intent extension in ${browserUrl}`,
        "detail" in result ? result.detail : "",
      );
    }
    return result;
  }

  console.log(`aiui: reloaded the intent extension in ${browserUrl} (via ${result.via})`);
  await reportLoadedArtifact(browserUrl, extensionId, wakePage, intent);
  return result;
}

/** Ask the reloaded extension which artifact it came from, and say so. */
async function reportLoadedArtifact(
  browserUrl: string,
  extensionId: string,
  wakePage: string | undefined,
  intent: Awaited<ReturnType<typeof findIntentExtension>>,
): Promise<void> {
  // Give the service worker a moment to come back up after the reload.
  await sleep(1200);
  const loaded = await evaluateInExtension<IntentDevStamp | null>(browserUrl, {
    extensionId,
    wakePage,
    expression:
      "fetch(chrome.runtime.getURL('aiui-dev.json'))" +
      ".then(r => r.ok ? r.json() : null).catch(() => null)",
  });
  if (!loaded.ok) {
    // Not fatal: the reload itself succeeded, we just couldn't ask.
    return;
  }
  const stamp = loaded.value;
  const wanted = intent.state === "ready" ? intent : undefined;

  if (!stamp) {
    if (wanted?.mode === "dev") {
      printWarning(
        "the browser is running the PRODUCTION build — your dev server's output is not being loaded",
        "Chrome installs an unpacked extension by PATH, and this browser was pointed at dist/.\n" +
          `Point it at the dev artifact once:  chrome://extensions → Load unpacked → ${wanted.dir}\n` +
          "(removing the old entry first), or relaunch the browser (`aiui browser`) — aiui passes\n" +
          "the dev artifact on --load-extension whenever its dev server is up.",
      );
    } else {
      console.log("aiui: the browser is running the production build (no dev server needed)");
    }
    return;
  }
  if (wanted?.mode === "dev" && wanted.stamp && stamp.runId !== wanted.stamp.runId) {
    printWarning(
      `the browser is running dev run ${stamp.runId}, but the current artifact is ${wanted.stamp.runId}`,
      "It reloaded from a different directory than the one this checkout is writing — see\n" +
        "chrome://extensions for the path it was loaded from.",
    );
    return;
  }
  console.log(`aiui: the browser is running dev run ${stamp.runId} from ${stamp.origin} ✓`);
}

/**
 * Wait until the dev artifact stamps itself complete with a *new* run id, and
 * its dev server answers. Returns undefined if it never does (Vite died, the
 * port was squatted, the timeout blew).
 */
async function waitForDevArtifact(
  devDir: string,
  before: IntentDevStamp | undefined,
  alive: () => boolean,
  timeoutMs = 60_000,
): Promise<IntentDevStamp | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && alive()) {
    const stamp = readDevStamp(devDir);
    if (stamp && stamp.runId !== before?.runId && (await devServerAlive(stamp.port))) {
      return stamp;
    }
    await sleep(300);
  }
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** The extension package's OWN vite (one Vite instance, its own plugins). */
function viteBin(root: string): string | undefined {
  try {
    const require = createRequire(join(root, "package.json"));
    return join(dirname(require.resolve("vite/package.json")), "bin", "vite.js");
  } catch {
    return undefined;
  }
}

function wrapperPath(): string {
  return join(cacheDir("native-host", { create: true }), "aiui-native-host.sh");
}

/**
 * Write the wrapper script (shared, user-cache) and return the NM manifest
 * body pointing at it. The wrapper embeds THIS checkout's CLI invocation, so
 * re-writing it on every install keeps it current after moves/reinstalls.
 */
function ensureWrapperAndManifest(extensionId: string): { wrapper: string; body: string } {
  const cli = resolvePackageCli("@habemus-papadum/aiui");
  const root = packageRoot("@habemus-papadum/aiui");

  const wrapper = wrapperPath();
  writeIfChanged(wrapper, wrapperScript(root, cli.command, cli.args));
  chmodSync(wrapper, 0o755);

  const manifest = {
    name: NATIVE_HOST_NAME,
    description: "aiui native-messaging host: channel discovery for the aiui browser extension",
    path: wrapper,
    type: "stdio",
    allowed_origins: [`chrome-extension://${extensionId}/`],
  };
  return { wrapper, body: `${JSON.stringify(manifest, null, 2)}\n` };
}

/** Write only when the content differs — these run on every launch. */
function writeIfChanged(file: string, content: string): boolean {
  try {
    if (readFileSync(file, "utf8") === content) {
      return false;
    }
  } catch {}
  writeFileSync(file, content);
  return true;
}

/**
 * Install the NM manifest into a session-browser profile
 * (`<user-data-dir>/NativeMessagingHosts/`) — the directory Chrome for
 * Testing actually consults (measured; see the module doc). Called by the
 * launchers whenever they load the intent extension: the profile lives in
 * aiui's own project-local cache, so unlike the global install this needs no
 * user decision — it is the same class of write as creating the profile.
 * Quiet and idempotent; no browser restart needed (NM manifests are read
 * per `connectNative`/`sendNativeMessage` call).
 */
export function installProfileNativeHost(
  userDataDir: string,
  options: ExtensionOptions = {},
): void {
  const { body } = ensureWrapperAndManifest(options.extensionId ?? DEFAULT_EXTENSION_ID);
  const dir = join(userDataDir, "NativeMessagingHosts");
  mkdirSync(dir, { recursive: true });
  writeIfChanged(join(dir, `${NATIVE_HOST_NAME}.json`), body);
}

/**
 * {@link installProfileNativeHost} as the launchers call it: only when the
 * intent extension is actually loadable (no point granting a host to an
 * extension that won't be there), and never fatal — a failed write degrades
 * to the panel's type-a-port fallback, with a note saying so. Called on both
 * the launch and the attach-to-running paths, so a profile whose browser
 * outlives many sessions still converges on a current manifest.
 */
export function ensureProfileNativeHost(
  userDataDir: string,
  intentReady: boolean,
  warn: (title: string, detail: string) => void,
): void {
  if (!intentReady) {
    return;
  }
  try {
    installProfileNativeHost(userDataDir);
  } catch (error) {
    warn(
      "couldn't install the native-messaging host into the browser profile — " +
        "the intent extension will need a manually typed port",
      error instanceof Error ? error.message : String(error),
    );
  }
}

function installNativeHost(options: ExtensionOptions): void {
  const extensionId = options.extensionId ?? DEFAULT_EXTENSION_ID;
  const { wrapper, body } = ensureWrapperAndManifest(extensionId);
  process.stdout.write(`wrote ${wrapper}\n`);

  for (const dir of nativeHostManifestDirs(process.platform, homedir())) {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${NATIVE_HOST_NAME}.json`);
    writeFileSync(file, body);
    process.stdout.write(`wrote ${file}\n`);
  }
  process.stdout.write(
    `native host installed for extension ${extensionId}.\n` +
      "No browser restart needed; reload the extension if it was already running.\n" +
      "(Session browsers launched by aiui get the manifest in their own profile\n" +
      "automatically — this global install is for browsers aiui does not manage.)\n",
  );
}

function statusNativeHost(): void {
  const wrapper = wrapperPath();
  process.stdout.write(`wrapper: ${wrapper} ${existsSync(wrapper) ? "(present)" : "(MISSING)"}\n`);
  for (const dir of nativeHostManifestDirs(process.platform, homedir())) {
    reportManifest(join(dir, `${NATIVE_HOST_NAME}.json`));
  }
  // The profiles aiui launches here (project-local; where CfT actually looks).
  const profiles = join(process.cwd(), ".aiui-cache", "chrome");
  let names: string[] = [];
  try {
    names = readdirSync(profiles, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {}
  for (const name of names) {
    reportManifest(join(profiles, name, "NativeMessagingHosts", `${NATIVE_HOST_NAME}.json`));
  }
}

function reportManifest(file: string): void {
  if (!existsSync(file)) {
    process.stdout.write(`absent:  ${file}\n`);
    return;
  }
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { allowed_origins?: string[] };
    process.stdout.write(`present: ${file} → ${parsed.allowed_origins?.join(", ")}\n`);
  } catch {
    process.stdout.write(`present: ${file} (unparseable)\n`);
  }
}
