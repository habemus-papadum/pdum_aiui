/**
 * `aiui config` — inspect and edit the two-level config.json.
 *
 *   aiui config                     the interactive browser (TTY), help otherwise
 *   aiui config tui                 same, explicitly
 *   aiui config show [--json]       every key: effective value + which file set it
 *   aiui config get <key>           the effective value (provenance on stderr)
 *   aiui config set <key> <value>   validated write — user level by default
 *   aiui config unset <key>         remove a key (e.g. to be re-asked on first run)
 *
 * `set`/`unset` write the **user** file unless `--project` says otherwise: user
 * config holds personal preferences; the project file (.aiui-cache/config.json)
 * may be shared or committed by a team, so touching it is a deliberate act.
 * Keys, types, defaults, and docs all come from `util/config-schema.ts` — the
 * same table validation uses, so what these commands print is what the loader
 * enforces.
 */
import { existsSync } from "node:fs";
import chalk from "chalk";
import {
  type AiuiConfig,
  configPaths,
  mergeAiuiConfig,
  readConfigFile,
  updateConfigFile,
} from "../util/config";
import {
  allConfigFields,
  type ConfigValue,
  describeDefault,
  formatConfigValue,
  parseFieldValue,
  type ResolvedField,
} from "../util/config-schema";
import { printError, printNote } from "../util/ui";

/** Which config file a write targets. */
export type ConfigLevel = "user" | "project";

/** Both config files, read once — the raw material for every subcommand. */
export interface ConfigLevels {
  paths: { user: string; project: string };
  user: AiuiConfig;
  project: AiuiConfig;
}

/** One field with its per-level values and resolved provenance. */
export interface FieldState extends ResolvedField {
  userValue?: ConfigValue;
  projectValue?: ConfigValue;
  /** The value the launcher would see (project beats user); undefined = unset. */
  effective?: ConfigValue;
  /** Where {@link effective} comes from; "default"/"unset" mean no file sets it. */
  source: ConfigLevel | "default" | "unset";
}

/** Read both config levels (missing files read as empty configs). */
export function readLevels(base: string = process.cwd()): ConfigLevels {
  const paths = configPaths(base);
  return {
    paths,
    user: readConfigFile(paths.user) ?? {},
    project: readConfigFile(paths.project) ?? {},
  };
}

/** Resolve every schema field against the two levels. */
export function fieldStates(levels: ConfigLevels): FieldState[] {
  return allConfigFields().map((resolved) => {
    const userValue = valueIn(levels.user, resolved);
    const projectValue = valueIn(levels.project, resolved);
    const effective = projectValue ?? userValue;
    const source: FieldState["source"] =
      projectValue !== undefined
        ? "project"
        : userValue !== undefined
          ? "user"
          : resolved.field.default !== undefined
            ? "default"
            : "unset";
    return { ...resolved, userValue, projectValue, effective, source };
  });
}

function valueIn(config: AiuiConfig, resolved: ResolvedField): ConfigValue | undefined {
  const sections = config as Record<string, Record<string, ConfigValue> | undefined>;
  return sections[resolved.section.name]?.[resolved.field.key];
}

/** Resolve a CLI key argument, reporting unknowns with the full key list. */
function resolveKeyArg(key: string, levels: ConfigLevels): FieldState | undefined {
  const hit = fieldStates(levels).find((state) => state.path === key);
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

export function runConfigShow(options: ShowOptions = {}, base: string = process.cwd()): void {
  const levels = readLevels(base);
  const states = fieldStates(levels);

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          files: {
            user: { path: levels.paths.user, exists: existsSync(levels.paths.user) },
            project: { path: levels.paths.project, exists: existsSync(levels.paths.project) },
          },
          user: levels.user,
          project: levels.project,
          effective: mergeAiuiConfig(levels.user, levels.project),
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(`user:    ${levels.paths.user}${presenceSuffix(levels.paths.user)}`);
  console.log(`project: ${levels.paths.project}${presenceSuffix(levels.paths.project)}`);
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
    chalk.dim(
      "\nProject beats user per key; CLI flags beat both. `aiui config` browses the docs interactively.",
    ),
  );
}

function presenceSuffix(path: string): string {
  return existsSync(path) ? "" : chalk.dim(" (not present)");
}

/** The value column of one `show`/TUI row: set value + source, or the default. */
export function valueCell(state: FieldState): string {
  if (state.effective !== undefined) {
    return `${chalk.cyan(formatConfigValue(state.effective))} ${chalk.dim(`(${state.source})`)}`;
  }
  return chalk.dim(
    state.field.default !== undefined
      ? `default: ${formatConfigValue(state.field.default)}`
      : "unset",
  );
}

// ── get ──────────────────────────────────────────────────────────────────────

export function runConfigGet(key: string, base: string = process.cwd()): void {
  const levels = readLevels(base);
  const state = resolveKeyArg(key, levels);
  if (!state) {
    return;
  }
  // Value on stdout (raw, script-friendly); provenance on stderr.
  if (state.effective !== undefined) {
    console.log(String(state.effective));
    const file = state.source === "project" ? levels.paths.project : levels.paths.user;
    console.error(chalk.dim(`# set in the ${state.source} config: ${file}`));
    return;
  }
  if (state.field.default !== undefined) {
    console.log(String(state.field.default));
    console.error(chalk.dim(`# built-in default — ${describeDefault(state.field)}`));
    return;
  }
  console.error(
    chalk.dim(`# not set in any config file — default: ${describeDefault(state.field)}`),
  );
}

// ── set / unset ──────────────────────────────────────────────────────────────

export interface WriteOptions {
  /** Target the project file (.aiui-cache/config.json) instead of the user file. */
  project?: boolean;
}

export function runConfigSet(
  key: string,
  raw: string,
  options: WriteOptions = {},
  base: string = process.cwd(),
): void {
  const levels = readLevels(base);
  const state = resolveKeyArg(key, levels);
  if (!state) {
    return;
  }
  const parsed = parseFieldValue(state.field, raw);
  if ("error" in parsed) {
    printError(`invalid value for ${state.path}: ${raw}`, parsed.error);
    process.exitCode = 1;
    return;
  }
  writeValue(levels, state, parsed.value, options.project ? "project" : "user");
}

/** The shared write path for `set` and the TUI. */
export function writeValue(
  levels: ConfigLevels,
  state: ResolvedField,
  value: ConfigValue,
  level: ConfigLevel,
): void {
  const file = updateConfigFile(levels.paths[level], (config) => {
    const sections = config as Record<string, Record<string, ConfigValue> | undefined>;
    sections[state.section.name] = { ...sections[state.section.name], [state.field.key]: value };
  });
  printNote(`wrote ${state.path}: ${formatConfigValue(value)} to ${file}`);
}

export function runConfigUnset(
  key: string,
  options: WriteOptions = {},
  base: string = process.cwd(),
): void {
  const levels = readLevels(base);
  const state = resolveKeyArg(key, levels);
  if (!state) {
    return;
  }
  removeValue(levels, state, options.project ? "project" : "user");
}

/** The shared unset path for `unset` and the TUI. */
export function removeValue(levels: ConfigLevels, state: ResolvedField, level: ConfigLevel): void {
  const path = levels.paths[level];
  const current = readConfigFile(path);
  const sections = (current ?? {}) as Record<string, Record<string, ConfigValue> | undefined>;
  if (sections[state.section.name]?.[state.field.key] === undefined) {
    printNote(`${state.path} is not set in the ${level} config (${path})`);
    return;
  }
  const file = updateConfigFile(path, (config) => {
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
