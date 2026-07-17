/**
 * aiui's two-level configuration file.
 *
 * Settings live in `config.json` at up to two places, merged per-key with the
 * more specific one winning:
 *
 *   <user cache>/config.json          e.g. ~/.cache/aiui/config.json (respects
 *                                     AIUI_CACHE / XDG_CACHE_HOME)
 *   <project>/.aiui-cache/config.json  next to the traces and Chrome profiles
 *
 * CLI flags override both. Everything is optional; a missing file is an empty
 * config. A *malformed* file is a hard error, not a warning — these settings
 * gate security-relevant behavior (`claude.args`, e.g. whether
 * `--dangerously-skip-permissions` is passed), and a typo that silently drops
 * such a flag is worse than a failed launch. The same reasoning rejects unknown
 * keys.
 *
 * What the keys are — types, enums, defaults, and documentation — lives in one
 * declarative table, `config-schema.ts`. Validation here walks that schema, and
 * the `aiui config` commands (show/get/set/tui) render from it, so the checks
 * and the docs cannot drift apart.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { projectCacheDir } from "@habemus-papadum/aiui-claude-channel";
import { cacheDir } from "@habemus-papadum/aiui-util";
import {
  type ChannelBind,
  type ChromeChannel,
  type ChromeMode,
  CONFIG_SECTIONS,
  type ConfigValue,
  DEFAULT_MANAGED_FLAVOR,
  fieldRuntimeType,
  formatConfigValue,
  invalidReason,
  isArrayField,
  type ManagedFlavor,
  type ManageMode,
} from "./config-schema";

export {
  CHANNEL_BINDS,
  CHROME_CHANNELS,
  CHROME_MODES,
  type ChannelBind,
  type ChromeChannel,
  type ChromeMode,
  DEFAULT_MANAGED_FLAVOR,
  FOR_TESTING_MODES,
  type ForTestingMode,
  MANAGE_MODES,
  MANAGED_FLAVORS,
  type ManagedFlavor,
  type ManageMode,
} from "./config-schema";

export const CONFIG_FILENAME = "config.json";

/**
 * The typed shape of a config file. Must mirror `CONFIG_SECTIONS` in
 * config-schema.ts — the schema rows carry the full per-key documentation and
 * defaults; the comments here are just orientation.
 */
export interface AiuiConfig {
  claude?: {
    /** Extra argv passed verbatim to `claude` on every launch (e.g. `--dangerously-skip-permissions`). */
    args?: string[];
    /** Auto-dismiss Claude Code's development-channel prompt (util/enter-nudge.ts). */
    enterNudge?: boolean;
  };
  channel?: {
    /** Which interface the channel web server binds: loopback (default) or host (LAN). */
    bind?: ChannelBind;
  };
  chrome?: {
    /** Attach the Chrome DevTools MCP (default: true). */
    enabled?: boolean;
    /** How the MCP reaches a browser: shared session browser, or its own. */
    mode?: ChromeMode;
    /** Attach to this DevTools endpoint instead of managing a browser at all. */
    browserUrl?: string;
    /** Fixed DevTools debug port for session browsers aiui launches (0 = OS-assigned). */
    debugPort?: number;
    /** Named profile under `.aiui-cache/chrome/` (default: "default"). */
    profile?: string;
    /** Explicit Chrome user data dir; takes precedence over `profile`. */
    dataDir?: string;
    /** Explicit browser binary to launch. Mutually exclusive with `channel`. */
    executablePath?: string;
    /** Installed Chrome release channel to launch. */
    channel?: ChromeChannel;
    /** Which browser aiui downloads and manages (default: chromium). */
    managed?: ManagedFlavor;
    /** How `aiui claude` keeps the managed browser installed/current. */
    manage?: ManageMode;
    /** @deprecated Old name for `manage`; still honored when `manage` is unset. */
    forTesting?: ManageMode;
    /** Launch Chrome headless (default: false). */
    headless?: boolean;
  };
}

/** The untyped view validation and merging work in: section → leaf values. */
type SectionValues = Record<string, ConfigValue>;

/**
 * Top-level sections that USED to be valid and are now gone. A config file that
 * still carries one must not hard-fail — that would break every existing
 * config on upgrade — so it is accepted and ignored, distinct from a
 * genuinely-unknown key (a typo), which still throws. `sidecars.*` retired when
 * the channel began hosting its whole standard set unconditionally (paint,
 * intent, bar, pencil): there is nothing left to toggle, so the key is inert and
 * safe to delete.
 */
const DEPRECATED_SECTIONS = new Set(["sidecars"]);

/**
 * Leaf keys that USED to be valid within a section and are now GONE — the
 * field-level twin of {@link DEPRECATED_SECTIONS}. A config still carrying one
 * is accepted and dropped (never copied into the loaded config), not a hard
 * error on upgrade. `chrome.buildExtension` / `chrome.autoCapture` retired with
 * the DevTools extension and page-side getDisplayMedia capture — both were long
 * parsed-and-ignored, and nothing reads them (owner, 2026-07-17).
 *
 * `claude.skipPermissions` retired when `--dangerously-skip-permissions` moved
 * into the general `claude.args` list (owner, 2026-07-17): a config still
 * carrying the old boolean is tolerated and dropped — it no longer adds the
 * flag, so run `aiui config set-dsp` to opt back in (docs/guide/warning).
 */
const DEPRECATED_FIELDS: Record<string, readonly string[]> = {
  claude: ["skipPermissions"],
  chrome: ["buildExtension", "autoCapture"],
};

/** The `config.json` paths consulted, user-level first (base: the project dir). */
export function configPaths(base: string = process.cwd()): { user: string; project: string } {
  return {
    user: join(cacheDir(undefined, { create: false }), CONFIG_FILENAME),
    project: join(projectCacheDir(base), CONFIG_FILENAME),
  };
}

/** Load and merge the user- and project-level configs (project wins per key). */
export function loadAiuiConfig(base: string = process.cwd()): AiuiConfig {
  const paths = configPaths(base);
  return mergeAiuiConfig(readConfigFile(paths.user) ?? {}, readConfigFile(paths.project) ?? {});
}

/** Merge two configs section-by-section; `override`'s keys win within a section. */
export function mergeAiuiConfig(base: AiuiConfig, override: AiuiConfig): AiuiConfig {
  const merged: Record<string, SectionValues> = {};
  for (const section of CONFIG_SECTIONS) {
    merged[section.name] = {
      ...(base as Record<string, SectionValues | undefined>)[section.name],
      ...(override as Record<string, SectionValues | undefined>)[section.name],
    };
  }
  return merged as AiuiConfig;
}

/**
 * Read one config file. Missing → undefined; unreadable JSON or an unexpected
 * shape → an error naming the file, so the fix is obvious.
 */
export function readConfigFile(file: string): AiuiConfig | undefined {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `invalid JSON in ${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return validateConfig(raw, file);
}

/** Walk `CONFIG_SECTIONS`, rejecting unknown keys, wrong types, and bad values. */
function validateConfig(raw: unknown, file: string): AiuiConfig {
  const root = asSection(raw, file, "the top level");
  const knownSections = CONFIG_SECTIONS.map((s) => s.name);
  for (const key of Object.keys(root)) {
    // A retired section is tolerated (accepted, then ignored below); a truly
    // unknown one is a typo and still throws — see DEPRECATED_SECTIONS.
    if (knownSections.includes(key) || DEPRECATED_SECTIONS.has(key)) {
      continue;
    }
    throw new Error(
      `unknown key "${key}" at the top level of ${file} — known keys: ${knownSections.join(", ")}`,
    );
  }

  const config: Record<string, SectionValues> = {};
  for (const section of CONFIG_SECTIONS) {
    if (root[section.name] === undefined) {
      continue;
    }
    const values = asSection(root[section.name], file, `"${section.name}"`);
    rejectUnknownKeys(
      values,
      // Known leaf keys PLUS any retired-but-tolerated ones for this section;
      // the copy loop below only carries `section.fields`, so a deprecated key
      // is accepted here and then dropped.
      [...section.fields.map((f) => f.key), ...(DEPRECATED_FIELDS[section.name] ?? [])],
      file,
      `"${section.name}"`,
    );
    // Absent keys stay absent (never `undefined`), or merging would let them
    // clobber a value from the other config level.
    const out: SectionValues = {};
    for (const field of section.fields) {
      const value = values[field.key];
      if (value === undefined) {
        continue;
      }
      const path = `${section.name}.${field.key}`;
      if (isArrayField(field)) {
        if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
          throw new Error(`expected an array of strings for ${path} in ${file}`);
        }
      } else {
        const type = fieldRuntimeType(field);
        if (typeof value !== type) {
          throw new Error(`expected a ${type} for ${path} in ${file}`);
        }
      }
      const reason = invalidReason(field, value as ConfigValue);
      if (reason) {
        throw new Error(
          `invalid ${path} ${formatConfigValue(value as ConfigValue)} in ${file} — ${reason}`,
        );
      }
      out[field.key] = value as ConfigValue;
    }
    config[section.name] = out;
  }
  return config as AiuiConfig;
}

/**
 * Persist a change to the **user-level** config (creating the file if needed).
 *
 * This is how interactive prompt answers like "never ask again" become
 * durable: they are per-user decisions, so they land in the user cache — never
 * in the project file, which may be shared/committed by a team.
 */
export function updateUserConfig(mutate: (config: AiuiConfig) => void): string {
  return updateConfigFile(configPaths().user, mutate);
}

/**
 * Persist a change to a specific config file — the general form behind
 * {@link updateUserConfig}, and how `aiui config set --project` writes the
 * project level deliberately.
 */
export function updateConfigFile(file: string, mutate: (config: AiuiConfig) => void): string {
  const config = readConfigFile(file) ?? {};
  mutate(config);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  return file;
}

/**
 * The managed browser this config prefers when nothing names a browser
 * explicitly — {@link DEFAULT_MANAGED_FLAVOR} (chromium) unless `chrome.managed`
 * overrides it. Flip the global default with
 * `aiui config set chrome.managed chrome-for-testing`.
 */
export function resolveManagedFlavor(chrome: AiuiConfig["chrome"] = {}): ManagedFlavor {
  return chrome.managed ?? DEFAULT_MANAGED_FLAVOR;
}

/**
 * The manage mode, honoring the deprecated `chrome.forTesting` alias: an
 * explicit `chrome.manage` wins, else the old key, else "prompt".
 */
export function resolveManageMode(chrome: AiuiConfig["chrome"] = {}): ManageMode {
  return chrome.manage ?? chrome.forTesting ?? "prompt";
}

function asSection(value: unknown, file: string, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`expected an object at ${where} of ${file}`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknownKeys(
  section: Record<string, unknown>,
  known: string[],
  file: string,
  where: string,
): void {
  for (const key of Object.keys(section)) {
    if (!known.includes(key)) {
      throw new Error(
        `unknown key "${key}" at ${where} of ${file} — known keys: ${known.join(", ")}`,
      );
    }
  }
}
