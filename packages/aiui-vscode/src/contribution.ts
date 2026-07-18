/**
 * The structured selection payload published on the session bus, and the pure
 * builder that produces it from editor coordinates.
 *
 * This file is the session bus's wire contract: `SelectionContribution` and
 * the `"contribution"` topic (it began as a mirror of the retired dev
 * overlay's session-contrib.ts; this is now the contract's only definition),
 * including its locator convention — 0-based editor/LSP coordinates in,
 * 1-based human-readable `file:line:col` / `file:start-end` out. Per the
 * project's rule, the payload is structured and verbatim — how a selection
 * reads in the final prompt is decided at lowering time by `composeIntent`,
 * never here.
 *
 * Deliberately free of the `vscode` module so it unit-tests without an
 * extension host and ships in the npm library build.
 */

/** The session-bus topic contributions ride on. */
export const SESSION_CONTRIBUTION_TOPIC = "contribution";

/**
 * A code selection contributed to the session's turn — the payload published
 * on {@link SESSION_CONTRIBUTION_TOPIC}.
 */
export interface SelectionContribution {
  kind: "selection";
  /** The selected text, verbatim. */
  text: string;
  /** Human locator: `file:line:col` (single line) or `file:start-end`. */
  sourceLoc?: string;
  /** Where the selection came from (here: a `vscode://file/…` URI). */
  url?: string;
  /** The contributing view's role — this provider says `"vscode"`. */
  role?: string;
  /** Inclusive line count; consumers derive it from `text` if omitted. */
  lines?: number;
}

/**
 * A selection in 0-based line/character coordinates — VS Code's (and LSP's)
 * native form. `file` should be project-relative with POSIX separators.
 */
export interface EditorSelection {
  file: string;
  text: string;
  startLine: number;
  startCharacter: number;
  endLine: number;
  endCharacter: number;
}

/**
 * Human-readable locator, converting 0-based editor coordinates to 1-based:
 * single line → `file:line:col`, multi line → `file:startLine-endLine`.
 */
export function selectionLoc(sel: EditorSelection): string {
  const startLine = sel.startLine + 1;
  if (sel.endLine !== sel.startLine) {
    return `${sel.file}:${startLine}-${sel.endLine + 1}`;
  }
  return `${sel.file}:${startLine}:${sel.startCharacter + 1}`;
}

/** Inclusive line count a selection spans (always ≥ 1). */
export function selectionLineCount(sel: EditorSelection): number {
  return sel.endLine - sel.startLine + 1;
}

/**
 * Build the bus contribution payload for an editor selection. `url` is the
 * provider's back-reference (a `vscode://file/…` URI), supplied by the caller
 * so this stays host-free and testable.
 */
export function selectionToContribution(sel: EditorSelection, url?: string): SelectionContribution {
  return {
    kind: "selection",
    text: sel.text,
    sourceLoc: selectionLoc(sel),
    ...(url !== undefined ? { url } : {}),
    role: "vscode",
    lines: selectionLineCount(sel),
  };
}
