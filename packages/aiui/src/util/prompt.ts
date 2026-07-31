/**
 * The interactive questions the launcher asks: {@link choose} (a keyed menu —
 * CfT install/update offers, first-run choices, `config yolo`) and
 * {@link promptSecret} (paste a value, or press Enter — the vendor-key
 * prompts).
 *
 * The visual language is `ui.ts`'s theme (see it for the why): a bold one-line
 * header carries the question, dimmed detail sits under a `│` gutter without
 * obscuring it, and the choices show their keys in the accent. The block is
 * printed once; the caret loops until an answer lands, so a mistyped key
 * reprints only a short hint, never the whole prompt again.
 *
 * Everything goes to stderr so a piped stdout stays clean. Answers match a
 * choice's key or any unambiguous label prefix. With a `defaultKey`, Enter
 * takes the default (marked in the list); without one the question requires an
 * explicit answer — for choices that should be definitive, not waved through.
 * Callers only ask in a real interactive session (TTY, not CI).
 */
import { createInterface } from "node:readline/promises";
import { readSecret } from "@habemus-papadum/aiui-util";
import chalk from "chalk";
import { glyph, textWidth, theme, wrap } from "./ui";

export interface Choice {
  key: string;
  label: string;
}

/** A question: its one-line purpose, and optional supporting detail. */
export interface Prompt {
  /** The header — what is being asked, in one line. */
  title: string;
  /** Supporting context — wrapped and dimmed under the gutter; never required. */
  detail?: string;
}

export async function choose(
  prompt: Prompt,
  choices: Choice[],
  defaultKey?: string,
): Promise<string> {
  render(prompt, choices, defaultKey);
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const caret = `${theme.muted(glyph.gutter)}  ${theme.accent(glyph.caret)} `;
  try {
    for (;;) {
      const raw = await rl.question(caret);
      const answer = raw.trim().toLowerCase();
      if (!answer) {
        if (defaultKey !== undefined) {
          return defaultKey;
        }
        continue; // definitive questions have no default — ask again
      }
      const hit =
        choices.find((c) => c.key.toLowerCase() === answer) ??
        choices.find((c) => c.label.toLowerCase().startsWith(answer));
      if (hit) {
        return hit.key;
      }
      const keys = choices.map((c) => theme.accent(c.key)).join(theme.muted(" · "));
      process.stderr.write(
        `${theme.muted(glyph.gutter)}  ${theme.muted(`not an option — enter ${keys}`)}\n`,
      );
    }
  } finally {
    rl.close();
  }
}

export interface SecretPromptOptions {
  /**
   * What an empty line means, in the imperative ("skip OpenAI"). Present, the
   * hint offers it and the caller must handle `""`; absent, the hint just asks
   * for a value.
   */
  emptyMeans?: string;
  /** Injectable stdin for tests; defaults to the process's. */
  stdin?: NodeJS.ReadStream;
}

/**
 * Ask for a secret with no menu in the way: **the paste is the answer, and an
 * empty line is the other answer.** No letter to press first — a keyed menu
 * ("p to paste, s to skip") makes the user answer a question about answering
 * the question, and every one of these prompts has exactly two outcomes that
 * the input itself already distinguishes.
 *
 * Characters echo as `*` (see aiui-util's `readSecret`), so a paste is
 * visibly the right length without ever showing the secret — the thing a
 * fully hidden prompt leaves you guessing about.
 *
 * Non-interactive stdin (a pipe) skips the block entirely and reads one line,
 * so `echo "$KEY" | aiui keys set openai` stays scriptable and quiet.
 */
export async function promptSecret(
  prompt: Prompt,
  options: SecretPromptOptions = {},
): Promise<string> {
  const stdin = options.stdin ?? process.stdin;
  if (!stdin.isTTY) {
    return readSecret(prompt.title, { stdin, stdout: process.stderr });
  }
  const hint = options.emptyMeans
    ? `paste it and press Enter — or press Enter alone to ${options.emptyMeans}`
    : "paste it and press Enter";
  const lines = [...header(prompt), theme.muted(glyph.gutter)];
  lines.push(`${theme.muted(glyph.gutter)}  ${theme.muted(hint)}`);
  lines.push(theme.muted(glyph.gutter));
  process.stderr.write(`${lines.join("\n")}\n`);
  const caret = `${theme.muted(glyph.gutter)}  ${theme.accent(glyph.caret)} `;
  const value = await readSecret(prompt.title, {
    stdin,
    stdout: process.stderr,
    promptText: caret,
  });
  return value;
}

/** The shared opening of every question block: header, then dimmed detail. */
function header(prompt: Prompt): string[] {
  const gutter = theme.muted(glyph.gutter);
  const lines: string[] = ["", `${theme.accent(glyph.marker)}  ${chalk.bold(prompt.title)}`];
  if (prompt.detail) {
    lines.push(gutter);
    for (const line of wrap(prompt.detail, textWidth() - 3)) {
      lines.push(`${gutter}  ${theme.muted(line)}`);
    }
  }
  return lines;
}

/** Print the question block once: header, dimmed detail, then the choices. */
function render(prompt: Prompt, choices: Choice[], defaultKey?: string): void {
  const gutter = theme.muted(glyph.gutter);
  const lines: string[] = [...header(prompt), gutter];
  const keyWidth = Math.max(...choices.map((c) => c.key.length));
  for (const c of choices) {
    const key = theme.accent.bold(c.key.padEnd(keyWidth));
    const suffix = c.key === defaultKey ? theme.muted("  (default)") : "";
    lines.push(`${gutter}    ${key}  ${c.label}${suffix}`);
  }
  lines.push(gutter);
  process.stderr.write(`${lines.join("\n")}\n`);
}
