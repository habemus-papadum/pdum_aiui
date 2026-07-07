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
 * gate security-relevant behavior (`claude.skipPermissions`), and a typo that
 * silently reverts to the dangerous default is worse than a failed launch. The
 * same reasoning rejects unknown keys.
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
  type ChromeChannel,
  type ChromeMode,
  CONFIG_SECTIONS,
  type ConfigValue,
  type ForTestingMode,
  fieldRuntimeType,
  formatConfigValue,
  invalidReason,
} from "./config-schema";

export {
  CHROME_CHANNELS,
  CHROME_MODES,
  type ChromeChannel,
  type ChromeMode,
  FOR_TESTING_MODES,
  type ForTestingMode,
} from "./config-schema";

export const CONFIG_FILENAME = "config.json";

/**
 * The typed shape of a config file. Must mirror `CONFIG_SECTIONS` in
 * config-schema.ts — the schema rows carry the full per-key documentation and
 * defaults; the comments here are just orientation.
 */
export interface AiuiConfig {
  claude?: {
    /** Launch Claude Code with `--dangerously-skip-permissions`. */
    skipPermissions?: boolean;
    /** Auto-dismiss Claude Code's development-channel prompt (util/enter-nudge.ts). */
    enterNudge?: boolean;
  };
  sidecars?: {
    /** Host the iPad paint sidecar — an unauthenticated LAN listener (default: false). */
    paint?: boolean;
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
    /** Chrome binary to launch. Mutually exclusive with `channel`. */
    executablePath?: string;
    /** Installed Chrome release channel to launch. */
    channel?: ChromeChannel;
    /** How `aiui claude` manages the Chrome for Testing install. */
    forTesting?: ForTestingMode;
    /** Launch Chrome headless (default: false). */
    headless?: boolean;
    /** Rebuild the aiui-devtools-extension on every launch in a dev checkout. */
    buildExtension?: boolean;
  };
}

/** The untyped view validation and merging work in: section → leaf values. */
type SectionValues = Record<string, ConfigValue>;

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
  rejectUnknownKeys(
    root,
    CONFIG_SECTIONS.map((s) => s.name),
    file,
    "the top level",
  );

  const config: Record<string, SectionValues> = {};
  for (const section of CONFIG_SECTIONS) {
    if (root[section.name] === undefined) {
      continue;
    }
    const values = asSection(root[section.name], file, `"${section.name}"`);
    rejectUnknownKeys(
      values,
      section.fields.map((f) => f.key),
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
      const type = fieldRuntimeType(field);
      if (typeof value !== type) {
        throw new Error(`expected a ${type} for ${path} in ${file}`);
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
