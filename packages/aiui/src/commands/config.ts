/**
 * `aiui config` — inspect and edit the (one, user-level) config.json.
 *
 *   aiui config                     the interactive browser (TTY), help otherwise
 *   aiui config tui                 same, explicitly
 *   aiui config show [--json]       every key: its value (or default)
 *   aiui config get <key>           the effective value (provenance on stderr)
 *   aiui config set <key> <value>   validated write
 *   aiui config unset <key>         remove a key (e.g. to be re-asked on first run)
 *
 * The project config layer retired with the browser-profiles redesign
 * (docs/proposals/browser-profiles.md) — there is exactly one file, in the
 * user cache. Keys, types, defaults, and docs all come from
 * `util/config-schema.ts` — the same table validation uses, so what these
 * commands print is what the loader enforces.
 */
import { existsSync } from "node:fs";
import chalk from "chalk";
import { type AiuiConfig, configPath, readConfigFile, updateConfigFile } from "../util/config";
import {
  allConfigFields,
  type ConfigValue,
  describeDefault,
  formatConfigValue,
  parseFieldValue,
  type ResolvedField,
} from "../util/config-schema";
import { type Choice, choose, type Prompt } from "../util/prompt";
import { printError, printNote } from "../util/ui";

/** The config file, read once — the raw material for every subcommand. */
export interface LoadedConfig {
  path: string;
  config: AiuiConfig;
}

/** One field with its set value (if any). */
export interface FieldState extends ResolvedField {
  /** The value the file sets; undefined = unset (the default applies). */
  value?: ConfigValue;
}

/** Read the config file (missing reads as an empty config). */
export function readLoadedConfig(): LoadedConfig {
  const path = configPath();
  return { path, config: readConfigFile(path) ?? {} };
}

/** Resolve every schema field against the file. */
export function fieldStates(loaded: LoadedConfig): FieldState[] {
  return allConfigFields().map((resolved) => {
    const sections = loaded.config as Record<string, Record<string, ConfigValue> | undefined>;
    const value = sections[resolved.section.name]?.[resolved.field.key];
    return value === undefined ? { ...resolved } : { ...resolved, value };
  });
}

/** Resolve a CLI key argument, reporting unknowns with the full key list. */
function resolveKeyArg(key: string, loaded: LoadedConfig): FieldState | undefined {
  const hit = fieldStates(loaded).find((state) => state.path === key);
  if (!hit) {
    printError(
      `unknown config key: ${key}`,
      `Known keys:\n  ${allConfigFields()
        .map((f) => f.path)
        .join("\n  ")}`,
    );
    process.exitCode = 1;
  }
  return hit;
}

// ── show ─────────────────────────────────────────────────────────────────────

export interface ShowOptions {
  json?: boolean;
}

export function runConfigShow(options: ShowOptions = {}): void {
  const loaded = readLoadedConfig();
  const states = fieldStates(loaded);

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          file: { path: loaded.path, exists: existsSync(loaded.path) },
          config: loaded.config,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(
    `config: ${loaded.path}${existsSync(loaded.path) ? "" : chalk.dim(" (not present)")}`,
  );
  const width = Math.max(...states.map((state) => state.path.length));
  let section = "";
  for (const state of states) {
    if (state.section.name !== section) {
      section = state.section.name;
      console.log(`\n${chalk.bold(section)} ${chalk.dim(`— ${state.section.summary}`)}`);
    }
    console.log(`  ${state.path.padEnd(width + 2)}${valueCell(state)}`);
  }
  console.log(
    chalk.dim("\nCLI flags beat config per launch. `aiui config` browses the docs interactively."),
  );
}

/** The value column of one `show`/TUI row: the set value, or the default. */
export function valueCell(state: FieldState): string {
  if (state.value !== undefined) {
    return `${chalk.cyan(formatConfigValue(state.value))} ${chalk.dim("(set)")}`;
  }
  return chalk.dim(
    state.field.default !== undefined
      ? `default: ${formatConfigValue(state.field.default)}`
      : "unset",
  );
}

// ── get ──────────────────────────────────────────────────────────────────────

/** A key's value for stdout: bare text for scalars, JSON for arrays. */
function scriptValue(value: ConfigValue): string {
  return Array.isArray(value) ? formatConfigValue(value) : String(value);
}

export function runConfigGet(key: string): void {
  const loaded = readLoadedConfig();
  const state = resolveKeyArg(key, loaded);
  if (!state) {
    return;
  }
  // Value on stdout (raw, script-friendly — arrays as JSON); provenance on stderr.
  if (state.value !== undefined) {
    console.log(scriptValue(state.value));
    console.error(chalk.dim(`# set in ${loaded.path}`));
    return;
  }
  if (state.field.default !== undefined) {
    console.log(scriptValue(state.field.default));
    console.error(chalk.dim(`# built-in default — ${describeDefault(state.field)}`));
    return;
  }
  console.error(chalk.dim(`# not set — default: ${describeDefault(state.field)}`));
}

// ── set / unset ──────────────────────────────────────────────────────────────

export function runConfigSet(key: string, raw: string): void {
  const loaded = readLoadedConfig();
  const state = resolveKeyArg(key, loaded);
  if (!state) {
    return;
  }
  const parsed = parseFieldValue(state.field, raw);
  if ("error" in parsed) {
    printError(`invalid value for ${state.path}: ${raw}`, parsed.error);
    process.exitCode = 1;
    return;
  }
  writeValue(state, parsed.value);
}

/** The shared write path for `set` and the TUI. */
export function writeValue(state: ResolvedField, value: ConfigValue): void {
  const file = updateConfigFile(configPath(), (config) => {
    const sections = config as Record<string, Record<string, ConfigValue> | undefined>;
    sections[state.section.name] = { ...sections[state.section.name], [state.field.key]: value };
  });
  printNote(`wrote ${state.path}: ${formatConfigValue(value)} to ${file}`);
}

// ── yolo ──────────────────────────────────────────────────────────────────────

/** Injectable for tests; matches {@link choose} without a default key. */
type Ask = (prompt: Prompt, choices: Choice[]) => Promise<string>;

/** The dangerous flag YOLO mode adds to `claude.args`. */
export const DSP_FLAG = "--dangerously-skip-permissions";

const YOLO_PROMPT: Prompt = {
  title: "Turn off both safety rails? (skip permissions + bind to your LAN)",
  detail:
    "--dangerously-skip-permissions lets Claude Code run tools — file edits, shell commands — " +
    "without asking first. channel.bind: host puts the channel's WHOLE web surface on every " +
    "interface, unauthenticated: prompt injection, /debug, and every sidecar become reachable " +
    "by anyone on your network — only ever on a network that is yours alone, never café Wi-Fi. " +
    "This command is the only thing that enables either.",
};

/**
 * `aiui config yolo` — the single, deliberately-inconvenient opt-in to the
 * dangerous posture: append `--dangerously-skip-permissions` to `claude.args`
 * AND set `channel.bind: host`. Both are OFF by default and asked for NOWHERE
 * else (first-run no longer offers host — see util/first-run.ts). Interactive:
 * it states both consequences and only acts on an explicit yes. The DSP append
 * is idempotent; bind is set to host outright.
 */
export async function runConfigYolo(ask: Ask = choose): Promise<void> {
  const answer = await ask(YOLO_PROMPT, [
    { key: "y", label: "yes — skip permissions AND bind host (I accept the risk)" },
    { key: "n", label: "no — leave things as they are" },
  ]);
  if (answer !== "y") {
    printNote("YOLO mode not enabled — nothing changed");
    return;
  }
  const file = updateConfigFile(configPath(), (config) => {
    const args = config.claude?.args ?? [];
    config.claude = {
      ...config.claude,
      args: args.includes(DSP_FLAG) ? args : [...args, DSP_FLAG],
    };
    config.channel = { ...config.channel, bind: "host" };
  });
  printNote(`YOLO mode enabled: ${DSP_FLAG} in claude.args + channel.bind: host (${file})`);
}

export function runConfigUnset(key: string): void {
  const loaded = readLoadedConfig();
  const state = resolveKeyArg(key, loaded);
  if (!state) {
    return;
  }
  removeValue(loaded, state);
}

/** The shared unset path for `unset` and the TUI. */
export function removeValue(loaded: LoadedConfig, state: ResolvedField): void {
  const sections = loaded.config as Record<string, Record<string, ConfigValue> | undefined>;
  if (sections[state.section.name]?.[state.field.key] === undefined) {
    printNote(`${state.path} is not set (${loaded.path})`);
    return;
  }
  const file = updateConfigFile(configPath(), (config) => {
    const mutable = config as Record<string, Record<string, ConfigValue> | undefined>;
    const section = { ...mutable[state.section.name] };
    delete section[state.field.key];
    if (Object.keys(section).length === 0) {
      delete mutable[state.section.name];
    } else {
      mutable[state.section.name] = section;
    }
  });
  printNote(`removed ${state.path} from ${file}`);
}
