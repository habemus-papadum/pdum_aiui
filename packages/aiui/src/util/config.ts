/**
 * aiui's configuration file — ONE flat, user-level `config.json`
 * (`<user cache>/config.json`, e.g. `~/.cache/aiui/config.json`, respecting
 * AIUI_CACHE / XDG_CACHE_HOME). The former project-level layer
 * (`.aiui-cache/config.json`) and the per-key merge are retired with the
 * browser-profiles redesign (docs/proposals/browser-profiles.md): browser
 * identity lives in the profile marker now, and what remains in config are
 * per-user machine facts.
 *
 * CLI flags override config. Everything is optional; a missing file is an
 * empty config. A *malformed* file is a hard error, not a warning — these
 * settings gate security-relevant behavior (`claude.args`, e.g. whether
 * `--dangerously-skip-permissions` is passed), and a typo that silently drops
 * such a flag is worse than a failed launch. The same reasoning rejects
 * unknown keys.
 *
 * What the keys are — types, enums, defaults, and documentation — lives in one
 * declarative table, `config-schema.ts`. Validation here walks that schema, and
 * the `aiui config` commands (show/get/set/tui) render from it, so the checks
 * and the docs cannot drift apart.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cacheDir } from "@habemus-papadum/aiui-util";
import {
  type ChannelBind,
  CONFIG_SECTIONS,
  type ConfigValue,
  fieldRuntimeType,
  formatConfigValue,
  invalidReason,
  isArrayField,
  type KeyDecisionValue,
  type ManageMode,
} from "./config-schema";

export {
  CHANNEL_BINDS,
  CHROME_CHANNELS,
  type ChannelBind,
  type ChromeChannel,
  DEFAULT_MANAGED_FLAVOR,
  KEY_DECISIONS,
  type KeyDecisionValue,
  MANAGE_MODES,
  MANAGED_FLAVORS,
  type ManagedFlavor,
  type ManageMode,
} from "./config-schema";

export const CONFIG_FILENAME = "config.json";

/**
 * The typed shape of the config file. Must mirror `CONFIG_SECTIONS` in
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
    /** How `aiui claude` keeps the managed browser binaries installed/current. */
    manage?: ManageMode;
    /** Launch Chrome headless (default: false). */
    headless?: boolean;
  };
  keys?: {
    /** Per-provider decision: "vault" (in use, secret in the OS vault) or "skip". */
    openai?: KeyDecisionValue;
    gemini?: KeyDecisionValue;
    elevenlabs?: KeyDecisionValue;
  };
}

/** The untyped view validation works in: section → leaf values. */
type SectionValues = Record<string, ConfigValue>;

/**
 * Top-level sections that USED to be valid and are now gone. A config file that
 * still carries one must not hard-fail — that would break every existing
 * config on upgrade — so it is accepted and ignored, distinct from a
 * genuinely-unknown key (a typo), which still throws.
 */
const DEPRECATED_SECTIONS = new Set(["sidecars"]);

/**
 * Leaf keys that USED to be valid within a section and are now GONE — the
 * field-level twin of {@link DEPRECATED_SECTIONS}. A config still carrying one
 * is accepted and dropped (never copied into the loaded config), not a hard
 * error on upgrade.
 *
 * The big chrome batch retired with the browser-profiles redesign
 * (2026-07-20): browser identity — enabled/mode/browserUrl/debugPort/profile/
 * dataDir/executablePath/channel/managed/forTesting — moved into the profile
 * marker or became flag-only. `claude.skipPermissions` retired earlier when
 * `--dangerously-skip-permissions` moved into `claude.args` (run
 * `aiui config yolo` to opt back in).
 */
const DEPRECATED_FIELDS: Record<string, readonly string[]> = {
  claude: ["skipPermissions"],
  chrome: [
    "buildExtension",
    "autoCapture",
    "enabled",
    "mode",
    "browserUrl",
    "debugPort",
    "profile",
    "dataDir",
    "executablePath",
    "channel",
    "managed",
    "forTesting",
  ],
};

/** The one `config.json` path (user-level). */
export function configPath(): string {
  return join(cacheDir(undefined, { create: false }), CONFIG_FILENAME);
}

/** Load the user-level config (missing file → empty config). */
export function loadAiuiConfig(): AiuiConfig {
  return readConfigFile(configPath()) ?? {};
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
 * Persist a change to the config (creating the file if needed). This is how
 * interactive prompt answers like "never ask again" become durable.
 */
export function updateUserConfig(mutate: (config: AiuiConfig) => void): string {
  return updateConfigFile(configPath(), mutate);
}

/** The general form behind {@link updateUserConfig} (tests use other paths). */
export function updateConfigFile(file: string, mutate: (config: AiuiConfig) => void): string {
  const config = readConfigFile(file) ?? {};
  mutate(config);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  return file;
}

/** The manage mode: `chrome.manage`, defaulting to "prompt". */
export function resolveManageMode(chrome: AiuiConfig["chrome"] = {}): ManageMode {
  return chrome.manage ?? "prompt";
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
