import chalk from "chalk";

/**
 * Styled terminal output — our small stand-in for Python's `rich`.
 *
 * One shared visual language for every launcher surface: the one-off asides
 * (notes/warnings/errors) here, and the interactive questions in `prompt.ts`,
 * which import this theme. The guiding ideas, after the first pass read as a
 * dense cyan wash:
 *  - **color is an accent, not a highlighter.** A calm blue marks structure
 *    (glyphs, keys, carets); the prose itself stays the terminal's own
 *    foreground so it is always legible on any background.
 *  - **hierarchy over density.** A bold one-line header says what is going on;
 *    supporting detail is dimmed and wrapped, present but never in the way.
 *  - **modern glyphs, not badges.** A small colored mark reads cleaner than a
 *    reverse-video ` NOTE ` block.
 */

// ── palette ──────────────────────────────────────────────────────────────────
// Truecolor hexes (chalk auto-downgrades on 256/16-color terminals). `muted`
// is chalk's own `dim` so body text adapts to light and dark backgrounds
// rather than betting on one grey.
export const theme = {
  /** The one accent: headers' marks, choice keys, the input caret. */
  accent: chalk.hex("#7aa2f7"),
  /** Confirmations ("wrote …", "enabled …"). */
  good: chalk.hex("#9ece6a"),
  /** Warnings — degraded, not fatal. */
  caution: chalk.hex("#e0af68"),
  /** Errors. */
  bad: chalk.hex("#f7768e"),
  /** Supporting prose and gutters — subordinate, theme-adaptive. */
  muted: chalk.dim,
} as const;

/** The glyph vocabulary — one place so it stays consistent. */
export const glyph = {
  marker: "◆", // an active question
  gutter: "│", // continuation lines under a question
  caret: "❯", // the input line
  note: "•",
  warn: "▲",
  error: "✖",
} as const;

// ── layout helpers (shared with prompt.ts) ───────────────────────────────────

/** A comfortable text column for the current terminal, capped for readability. */
export function textWidth(max = 78): number {
  const cols = process.stderr.columns ?? 80;
  return Math.max(40, Math.min(max, cols - 4));
}

/**
 * Wrap a paragraph to `width` columns on word boundaries (never mid-word).
 * Blank lines in the input are preserved, so multi-paragraph detail survives.
 */
export function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      if (line && line.length + 1 + word.length > width) {
        out.push(line);
        line = word;
      } else {
        line = line ? `${line} ${word}` : word;
      }
    }
    out.push(line);
  }
  return out;
}

/** Shared body: a colored glyph, a header, and optional dimmed/wrapped detail. */
function aside(mark: string, title: string, detail?: string): void {
  console.error(`${mark} ${title}`);
  if (detail) {
    for (const line of wrap(detail, textWidth() - 2)) {
      console.error(`  ${theme.muted(line)}`);
    }
  }
}

export function printError(title: string, detail?: string): void {
  aside(theme.bad(glyph.error), theme.bad.bold(title), detail);
}

export function printWarning(title: string, detail?: string): void {
  aside(theme.caution(glyph.warn), theme.caution(title), detail);
}

/** A one-off informational aside (tips, config-written confirmations). */
export function printNote(title: string, detail?: string): void {
  aside(theme.accent(glyph.note), title, detail);
}
