/**
 * `aiui config tui` (and bare `aiui config`) — the interactive config browser.
 *
 * A two-level @inquirer/prompts flow over the schema in util/config-schema.ts:
 * the main list shows every key with its value, and the description panel
 * under the list is the documentation card — what the key does, its default,
 * and what the config file says. Picking a key opens its actions: set (enums
 * and booleans become menus, strings and numbers a validated input), unset
 * where it's set, or back. Writes reuse the same code paths as
 * `aiui config set`/`unset`, so the TUI can't drift from the CLI.
 *
 * Ctrl-C anywhere leaves quietly — it's a browser, not a wizard.
 */
import { homedir } from "node:os";
import { input, Separator, select } from "@inquirer/prompts";
import chalk from "chalk";
import {
  CONFIG_SECTIONS,
  type ConfigValue,
  describeDefault,
  formatConfigValue,
  parseFieldValue,
} from "../util/config-schema";
import { printError } from "../util/ui";
import {
  type FieldState,
  fieldStates,
  type LoadedConfig,
  readLoadedConfig,
  removeValue,
  valueCell,
  writeValue,
} from "./config";

export async function runConfigTui(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    printError(
      "aiui config tui needs an interactive terminal",
      "In scripts and non-TTY sessions use `aiui config show` (or `show --json`).",
    );
    process.exitCode = 1;
    return;
  }
  console.log(chalk.dim(`config: ${tildify(readLoadedConfig().path)}`));
  try {
    for (;;) {
      // Re-read every lap so an edit (or a concurrent one) is visible immediately.
      const loaded = readLoadedConfig();
      const picked = await pickField(loaded);
      if (!picked) {
        return;
      }
      await editField(loaded, picked);
    }
  } catch (error) {
    if (error instanceof Error && error.name === "ExitPromptError") {
      return; // Ctrl-C: leave quietly
    }
    throw error;
  }
}

/** The main list: every key, grouped by section, documented in the panel below. */
async function pickField(loaded: LoadedConfig): Promise<FieldState | undefined> {
  const states = fieldStates(loaded);
  const width = Math.max(...states.map((state) => state.path.length)) + 2;
  const choices: (
    | Separator
    | { name: string; value: FieldState | undefined; description: string }
  )[] = [];
  for (const section of CONFIG_SECTIONS) {
    choices.push(new Separator(chalk.dim(`── ${section.name} — ${section.summary}`)));
    for (const state of states.filter((s) => s.section.name === section.name)) {
      choices.push({
        name: `${state.path.padEnd(width)}${valueCell(state)}`,
        value: state,
        description: fieldCard(state),
      });
    }
  }
  choices.push(new Separator(" "));
  choices.push({ name: "exit", value: undefined, description: "Leave the config browser." });
  return select({
    message: "aiui config",
    choices,
    pageSize: choices.length,
    loop: false,
  });
}

/** The documentation card for one key: doc, default, and the file's value. */
function fieldCard(state: FieldState): string {
  const lines = [chalk.bold(state.field.summary)];
  if (state.field.doc) {
    lines.push(wrap(state.field.doc, 76));
  }
  lines.push("");
  if (state.field.type === "enum") {
    lines.push(`allowed: ${(state.field.values ?? []).join(" | ")}`);
  }
  lines.push(`default: ${describeDefault(state.field)}`);
  lines.push(
    `set:     ${state.value === undefined ? chalk.dim("(not set)") : formatConfigValue(state.value)}`,
  );
  return lines.join("\n");
}

/** The per-key action menu, then the edit itself. */
async function editField(loaded: LoadedConfig, state: FieldState): Promise<void> {
  const actions: (Separator | { name: string; value: string; description?: string })[] = [
    { name: "set", value: "set", description: loaded.path },
  ];
  if (state.value !== undefined) {
    actions.push({
      name: `unset (currently ${formatConfigValue(state.value)})`,
      value: "unset",
    });
  }
  actions.push(new Separator());
  actions.push({ name: "back", value: "back" });

  const action = await select({
    message: `${state.path} — ${state.field.summary}`,
    choices: actions,
  });
  if (action === "back") {
    return;
  }
  if (action === "unset") {
    removeValue(loaded, state);
    return;
  }
  const value = await askValue(state);
  if (value !== undefined) {
    writeValue(state, value);
  }
}

/** Prompt for a new value: menus for enums/booleans, validated input otherwise. */
async function askValue(state: FieldState): Promise<ConfigValue | undefined> {
  const mark = (value: ConfigValue): string => {
    if (value === state.value) {
      return " (current)";
    }
    return value === state.field.default ? " (default)" : "";
  };
  if (state.field.type === "boolean") {
    return select({
      message: `${state.path} =`,
      choices: [true, false].map((value) => ({
        name: `${value}${chalk.dim(mark(value))}`,
        value: value as ConfigValue,
      })),
    });
  }
  if (state.field.type === "enum") {
    return select({
      message: `${state.path} =`,
      choices: (state.field.values ?? []).map((value) => ({
        name: `${value}${chalk.dim(mark(value))}`,
        value: value as ConfigValue,
      })),
    });
  }
  // Array fields round-trip through their JSON form (the input parses JSON);
  // scalars keep their bare text so a plain string edits as itself.
  const seeded =
    state.value === undefined
      ? undefined
      : Array.isArray(state.value)
        ? formatConfigValue(state.value)
        : String(state.value);
  const raw = await input({
    message: `${state.path} = `,
    default: seeded,
    validate: (text) => {
      const parsed = parseFieldValue(state.field, text);
      return "error" in parsed ? parsed.error : true;
    },
  });
  const parsed = parseFieldValue(state.field, raw);
  return "error" in parsed ? undefined : parsed.value;
}

/** Shorten a home-dir prefix to `~` for display. */
function tildify(path: string): string {
  const home = homedir();
  return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

/** Greedy wrap at `width` columns — inquirer descriptions don't wrap themselves. */
function wrap(text: string, width: number): string {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) {
    lines.push(line);
  }
  return lines.join("\n");
}
