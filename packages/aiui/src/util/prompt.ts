/**
 * A minimal interactive chooser for the launcher's rare questions (CfT
 * install/update offers, first-run choices). Menus print to stderr so a piped
 * stdout stays clean; answers match a choice's key or any unambiguous label
 * prefix. With a `defaultKey`, Enter takes the default; without one the
 * question requires an explicit answer (for choices that should be definitive,
 * not waved through). Callers are responsible for only asking in a real
 * interactive session (TTY, not CI).
 */
import { createInterface } from "node:readline/promises";
import chalk from "chalk";

export interface Choice {
  key: string;
  label: string;
}

export async function choose(
  question: string,
  choices: Choice[],
  defaultKey?: string,
): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const menu = choices
      .map(
        (c) =>
          `  ${chalk.bold(`[${c.key === defaultKey ? c.key.toUpperCase() : c.key}]`)} ${c.label}`,
      )
      .join("\n");
    for (;;) {
      const raw = await rl.question(`${chalk.cyan(question)}\n${menu}\n> `);
      const answer = raw.trim().toLowerCase();
      if (!answer) {
        if (defaultKey !== undefined) {
          return defaultKey;
        }
        continue; // definitive questions have no default — ask again
      }
      const hit =
        choices.find((c) => c.key === answer) ??
        choices.find((c) => c.label.toLowerCase().startsWith(answer));
      if (hit) {
        return hit.key;
      }
      // Unrecognized — the loop re-prints the menu.
    }
  } finally {
    rl.close();
  }
}
