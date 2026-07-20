/**
 * `aiui extension` — the intent client extension's native side
 * (`install-native-host`, `status`): the native-messaging host lets the
 * extension enumerate channels cold, since the on-disk registry is
 * unreachable from a browser (an extension page's origin is
 * `chrome-extension://…`, so unlike the channel-served page it cannot read
 * its port off its own URL).
 *
 * Since the aiui-registry migration (docs/proposals/aiui-registry.md §9) the
 * host is a COMPILED binary shipped by `@habemus-papadum/aiui-registry`'s
 * platform packages — not a Node subcommand. Installation, idempotent on
 * every launch:
 *
 *  1. Copy the platform binary into the user cache under a VERSION-SUFFIXED
 *     name (`native-host/aiui-registry-host-<version>`). Never overwrite a
 *     fixed path: a running `connectNative` host may be executing it; a new
 *     version gets a new file, the wrapper repoints. (Old versions accumulate
 *     — GC deliberately deferred.)
 *  2. Write the wrapper script: Chrome spawns NM hosts with a minimal env and
 *     cwd `/`, so the machine-specific facts are baked as env — notably
 *     `AIUI_CLAUDE_BIN`, the absolute Claude Code path the host needs for the
 *     live session-name join (Chrome's PATH can't resolve `claude`).
 *     Re-resolved and rewritten via writeIfChanged on EVERY launch, so a moved
 *     Claude install self-heals on the next `aiui claude`.
 *  3. Write the NM manifest pointing at the wrapper — into each browser's
 *     user-level `NativeMessagingHosts/` for the explicit global install, or
 *     into a session-browser profile's own `<user-data-dir>/NativeMessagingHosts/`
 *     (where Chrome for Testing actually looks — measured; see
 *     {@link installProfileNativeHost}) for the automatic per-launch install.
 */
import {
  accessSync,
  chmodSync,
  copyFileSync,
  existsSync,
  constants as fsConstants,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { HOST_BINARY_NAME, resolveHostBinary } from "@habemus-papadum/aiui-registry";
import { cacheDir } from "@habemus-papadum/aiui-util";
import { profilesRoot } from "../util/profile";
import { printError } from "../util/ui";

/** The NM host name (lowercase alphanumerics, dots, underscores only). */
export const NATIVE_HOST_NAME = "com.habemus_papadum.aiui";

/**
 * The intent client's stable unpacked-extension id (see
 * `packages/aiui-intent-client/src/ext/manifest.ts`, which owns the key this
 * is derived from). Duplicated rather than imported: `aiui` does not depend on
 * the intent client, and this is a 32-char constant that changes only if the
 * key does.
 */
export const INTENT_CLIENT_EXTENSION_ID = "cdpbfpcelmifhagikjlfpgfipggcmdeg";

export interface ExtensionOptions {
  extensionId?: string;
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

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, fsConstants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Absolute path to the `claude` binary, resolved from PATH — done by the
 * INSTALLER (which has the user's PATH) and baked into the wrapper, because
 * the host itself runs under Chrome's minimal env where `claude` can't
 * resolve by name. Undefined when not found: the host then reports
 * "claude-missing" loudly instead of silently losing session names.
 */
export function resolveClaudeBinary(
  pathEnv: string = process.env.PATH ?? "",
  isExecutable: (path: string) => boolean = isExecutableFile,
): string | undefined {
  for (const dir of pathEnv.split(":")) {
    if (!dir) {
      continue;
    }
    const candidate = join(dir, "claude");
    if (isExecutable(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/** The wrapper script body. Exported for tests. */
export function wrapperScript(binary: string, claude: string | undefined): string {
  const q = (s: string): string => `"${s.replace(/(["\\$`])/g, "\\$1")}"`;
  return [
    "#!/bin/sh",
    "# aiui native-messaging host wrapper — generated by aiui; rewritten every launch.",
    "# Chrome spawns NM hosts with a minimal env and cwd /: the machine-specific",
    "# facts (compiled host binary, Claude Code path) are baked here as absolutes.",
    ...(claude ? [`AIUI_CLAUDE_BIN=${q(claude)}`, "export AIUI_CLAUDE_BIN"] : []),
    `exec ${q(binary)}`,
    "",
  ].join("\n");
}

const ACTIONS = ["install-native-host", "status"] as const;

export async function runExtension(action: string, options: ExtensionOptions = {}): Promise<void> {
  switch (action) {
    case "install-native-host":
      installNativeHost(options);
      return;
    case "status":
      statusNativeHost();
      return;
    case "dev":
    case "reload":
      printError(
        `aiui extension ${action} is gone — the frozen aiui-extension was deleted`,
        "The intent client's extension is a static build:\n" +
          "  pnpm -C packages/aiui-intent-client ext   (build + load into the session browser)",
      );
      process.exitCode = 1;
      return;
    default:
      throw new Error(`aiui extension: unknown action "${action}" (${ACTIONS.join(" | ")})`);
  }
}

/** The installed host artifacts (per-machine facts, resolved fresh). */
export interface HostArtifacts {
  /** Version-suffixed copy of the compiled host in the user cache. */
  binary: string;
  /** The env-baking wrapper the NM manifests point at. */
  wrapper: string;
  /** The registry package's version (the binary suffix). */
  version: string;
  /** The baked Claude Code path, when PATH resolution found one. */
  claude?: string;
}

function wrapperPath(): string {
  return join(cacheDir("native-host", { create: true }), "aiui-native-host.sh");
}

/**
 * Ensure the compiled host + wrapper exist in the user cache (§9 steps 1–2).
 * Returns undefined when no platform binary is installed (unsupported
 * platform, or a checkout without the registry package's platform dep) —
 * callers degrade loudly.
 */
export function ensureHostArtifacts(): HostArtifacts | undefined {
  const source = resolveHostBinary();
  if (!source || !existsSync(source)) {
    return undefined;
  }
  let version = "0";
  try {
    const pkg = JSON.parse(readFileSync(join(dirname(source), "package.json"), "utf8")) as {
      version?: string;
    };
    version = pkg.version ?? version;
  } catch {
    // Version stays "0" — still functional, just an odd suffix.
  }
  const dir = cacheDir("native-host", { create: true });
  const binary = join(dir, `${HOST_BINARY_NAME}-${version}`);
  if (!existsSync(binary)) {
    copyFileSync(source, binary);
  }
  chmodSync(binary, 0o755);

  const claude = resolveClaudeBinary();
  const wrapper = wrapperPath();
  writeIfChanged(wrapper, wrapperScript(binary, claude));
  chmodSync(wrapper, 0o755);
  return { binary, wrapper, version, ...(claude !== undefined ? { claude } : {}) };
}

/** The NM manifest body for a wrapper + extension id. */
function manifestBody(wrapper: string, extensionId: string): string {
  const manifest = {
    name: NATIVE_HOST_NAME,
    description: "aiui native-messaging host: channel discovery for the aiui intent client",
    path: wrapper,
    type: "stdio",
    // The host answers one question — "which channels are up?" — for the
    // intent client's cold start. An overridden id rides alongside the stable
    // one so a custom build never locks the shipped client out.
    allowed_origins: [
      ...new Set([
        `chrome-extension://${extensionId}/`,
        `chrome-extension://${INTENT_CLIENT_EXTENSION_ID}/`,
      ]),
    ],
  };
  return `${JSON.stringify(manifest, null, 2)}\n`;
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
 * launchers whenever they load the intent client's extension: the profile
 * lives in aiui's own project-local cache, so unlike the global install this
 * needs no user decision — it is the same class of write as creating the
 * profile. Quiet and idempotent; no browser restart needed (NM manifests are
 * read per `connectNative`/`sendNativeMessage` call).
 *
 * @throws when no compiled host binary is available for this platform.
 */
export function installProfileNativeHost(
  userDataDir: string,
  options: ExtensionOptions = {},
): void {
  const artifacts = ensureHostArtifacts();
  if (!artifacts) {
    throw new Error(
      `no compiled native-messaging host for ${process.platform}-${process.arch} — ` +
        "is @habemus-papadum/aiui-registry's platform package installed?",
    );
  }
  const dir = join(userDataDir, "NativeMessagingHosts");
  mkdirSync(dir, { recursive: true });
  writeIfChanged(
    join(dir, `${NATIVE_HOST_NAME}.json`),
    manifestBody(artifacts.wrapper, options.extensionId ?? INTENT_CLIENT_EXTENSION_ID),
  );
}

/**
 * {@link installProfileNativeHost} as the launchers call it: only when the
 * intent client's extension is actually loadable (no point granting a host to
 * an extension that won't be there), and never fatal — a failed write
 * degrades to the panel's type-a-port fallback, with a note saying so. Called
 * on both the launch and the attach-to-running paths, so a profile whose
 * browser outlives many sessions still converges on a current manifest.
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
  const artifacts = ensureHostArtifacts();
  if (!artifacts) {
    printError(
      `no compiled native-messaging host for ${process.platform}-${process.arch}`,
      "The host ships with @habemus-papadum/aiui-registry's platform packages — " +
        "reinstall aiui (or check `npm ls @habemus-papadum/aiui-registry`).",
    );
    process.exitCode = 1;
    return;
  }
  const extensionId = options.extensionId ?? INTENT_CLIENT_EXTENSION_ID;
  process.stdout.write(`host binary: ${artifacts.binary}\n`);
  process.stdout.write(`wrote ${artifacts.wrapper}\n`);
  if (artifacts.claude === undefined) {
    process.stdout.write(
      "WARNING: no `claude` on PATH — session names will report claude-missing " +
        "until aiui runs again with Claude Code installed.\n",
    );
  }

  const body = manifestBody(artifacts.wrapper, extensionId);
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
  const artifacts = ensureHostArtifacts();
  if (artifacts) {
    process.stdout.write(`binary:  ${artifacts.binary} (v${artifacts.version})\n`);
    process.stdout.write(`wrapper: ${artifacts.wrapper}\n`);
    process.stdout.write(`claude:  ${artifacts.claude ?? "(NOT FOUND on PATH — names degrade)"}\n`);
  } else {
    process.stdout.write(
      `binary:  MISSING — no compiled host for ${process.platform}-${process.arch}\n`,
    );
  }
  for (const dir of nativeHostManifestDirs(process.platform, homedir())) {
    reportManifest(join(dir, `${NATIVE_HOST_NAME}.json`));
  }
  // The user-level browser profiles (their user-data dirs are where the
  // managed browsers actually look the manifest up).
  const profiles = profilesRoot({ create: false });
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
