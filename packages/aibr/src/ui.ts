import { createInterface } from "node:readline/promises";
import { type Config, type Paths, redactEndpoint, type Selection } from "./model.ts";
import { inspectProfiles } from "./profiles.ts";
import { listTargets, selectionForRow } from "./targets.ts";

export interface Choice<T> {
  value: T;
  label: string;
}
export interface Prompts {
  interactive: boolean;
  text(message: string, fallback?: string, validate?: (value: string) => void): Promise<string>;
  choose<T>(message: string, choices: Choice<T>[], fallback?: T): Promise<T>;
  confirm(message: string, fallback?: boolean): Promise<boolean>;
  note(message: string): void;
}

export const terminal: Prompts = {
  get interactive() {
    return !!process.stdin.isTTY && !!process.stderr.isTTY;
  },
  note(message) {
    process.stderr.write(`${message}\n`);
  },
  async text(message, fallback, validate) {
    requireTerminal(this);
    while (true) {
      const readline = createInterface({ input: process.stdin, output: process.stderr });
      const controller = new AbortController();
      const cancel = () => controller.abort();
      readline.on("SIGINT", cancel);
      readline.on("close", cancel);
      let input: string;
      try {
        input = (
          await readline.question(`${message}${fallback ? ` [${fallback}]` : ""}: `, {
            signal: controller.signal,
          })
        ).trim();
      } catch {
        throw new Error("Cancelled; no further changes made");
      } finally {
        readline.removeListener("close", cancel);
        readline.removeListener("SIGINT", cancel);
        readline.close();
      }
      const value = input || fallback || "";
      try {
        validate?.(value);
        return value;
      } catch (error) {
        this.note(error instanceof Error ? error.message : String(error));
      }
    }
  },
  async choose<T>(message: string, choices: Choice<T>[], fallback?: T): Promise<T> {
    requireTerminal(this);
    if (!choices.length) throw new Error("No choices available");
    this.note(`\n${message}`);
    choices.forEach((choice, index) => {
      this.note(
        `  ${index + 1}. ${choice.label}${choice.value === fallback ? " (current/default)" : ""}`,
      );
    });
    const defaultIndex = choices.findIndex((choice) => choice.value === fallback);
    const answer = await this.text(
      "Choose a number (Ctrl-C to cancel)",
      defaultIndex < 0 ? undefined : String(defaultIndex + 1),
      (value) => {
        if (!/^\d+$/.test(value) || !choices[Number(value) - 1])
          throw new Error(`Enter a number from 1 to ${choices.length}`);
      },
    );
    return choices[Number(answer) - 1].value;
  },
  async confirm(message, fallback = false) {
    const answer = await this.text(`${message} (y/n)`, fallback ? "y" : "n", (value) => {
      if (!/^(y|yes|n|no)$/i.test(value)) throw new Error("Enter y or n");
    });
    return /^y/i.test(answer);
  },
};

export function requireTerminal(ui: Prompts): void {
  if (!ui.interactive)
    throw new Error(
      "This chooser needs an interactive terminal; supply a value for --profile, --target or the command argument instead",
    );
}

export async function pickProfile(
  p: Paths,
  config: Config,
  ui = terminal,
  localOnly = false,
): Promise<string> {
  requireTerminal(ui);
  const rows = (await inspectProfiles(p, config)).filter(
    (row) => !row.error && (!localOnly || row.profile),
  );
  if (!rows.length) throw new Error("No profiles yet. Run: aibr profile create");
  return ui.choose(
    "Browser profile",
    rows.map((row) => {
      if ("endpoint" in row.target)
        return { value: row.name, label: `${row.name} — ${redactEndpoint(row.target.endpoint)}` };
      if ("provider" in row.target)
        return {
          value: row.name,
          label: `${row.name} — provider ${row.target.provider}: ${row.target.id}`,
        };
      const browser = row.profile?.browser;
      return {
        value: row.name,
        label: `${row.name} — ${browser ? ("managed" in browser ? browser.managed : browser.executable) : "unknown"} · port ${row.profile?.launch.debugPort} · ${row.dir}`,
      };
    }),
  );
}

export async function pickTarget(p: Paths, config: Config, ui = terminal): Promise<Selection> {
  requireTerminal(ui);
  const rows = await listTargets(p, config, true);
  if (!rows.length)
    throw new Error("No browser targets. Run aibr profile create or aibr target add first.");
  return selectionForRow(
    await ui.choose(
      "Browser target",
      rows.map((row) => ({
        value: row,
        label: `${row.label} [${row.status}] ${row.detail ?? ""}`,
      })),
    ),
  );
}
