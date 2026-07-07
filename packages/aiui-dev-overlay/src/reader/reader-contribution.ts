/**
 * session-contribution.ts — the pure logic behind the session panel's
 * "Add to prompt →" action. Kept realm-free (no Monaco, no bus, no DOM) so it
 * unit-tests without a browser: a {@link SelectionSnapshot} (0-based LSP coords)
 * in, a {@link SelectionContribution} (1-based human locator) out.
 *
 * The reader publishes this payload on {@link SESSION_CONTRIBUTION_TOPIC}; the
 * app-tab host formats it into the turn text (short → inline, long → fenced).
 */
import type { SelectionSnapshot } from "@habemus-papadum/aiui-code";
import type { SelectionContribution } from "../session-contrib";

/**
 * Human-readable locator for a selection, converting the snapshot's 0-based LSP
 * range to 1-based coordinates:
 *  - single line → `file:line:col`
 *  - multi line  → `file:startLine-endLine`
 */
export function selectionLoc(sel: SelectionSnapshot): string {
  const startLine = sel.range.start.line + 1;
  if (sel.range.end.line !== sel.range.start.line) {
    return `${sel.file}:${startLine}-${sel.range.end.line + 1}`;
  }
  return `${sel.file}:${startLine}:${sel.range.start.character + 1}`;
}

/** Inclusive line count a selection spans (always ≥ 1). */
export function selectionLineCount(sel: SelectionSnapshot): number {
  return sel.range.end.line - sel.range.start.line + 1;
}

/**
 * Build the bus contribution payload for a code selection. `url` is the
 * contributing view's `location.href` (supplied by the caller so this stays
 * DOM-free and testable).
 */
export function selectionToContribution(
  sel: SelectionSnapshot,
  url: string,
): SelectionContribution {
  return {
    kind: "selection",
    text: sel.text,
    sourceLoc: selectionLoc(sel),
    url,
    role: "code",
    lines: selectionLineCount(sel),
  };
}

/** A one-line, whitespace-collapsed, length-capped preview of selected text. */
export function excerpt(text: string, max = 80): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}
