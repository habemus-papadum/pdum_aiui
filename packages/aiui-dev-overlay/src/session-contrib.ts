/**
 * Contributions: what a non-host view (the code reader today) sends over the
 * session bus to add to the turn the app tab is building.
 *
 * A contribution rides a bus `publish` on {@link SESSION_CONTRIBUTION_TOPIC}.
 * The host (the multimodal turn) ingests a **selection** contribution as a
 * structured `code-selection` event via `Engine.codeSelection` — the preview
 * shows it as a chip, the trace records the selection itself, and how it reads
 * in the prompt is decided at LOWERING time by `composeIntent`'s short/long
 * rule (short → inlined "regarding `file:line`: `code`", long → a fenced block
 * under a location header — see the pipeline's `SHORT_SELECTION_CHARS`). A
 * **text** contribution still lands as plain turn text via `Engine.contribute`.
 */
import { SHORT_SELECTION_CHARS } from "./intent-pipeline";

/** The bus topic contributions are published on. */
export const SESSION_CONTRIBUTION_TOPIC = "contribution";

export { SHORT_SELECTION_CHARS };

/** A source selection contributed from another view (e.g. a code selection). */
export interface SelectionContribution {
  kind: "selection";
  /** The selected text. */
  text: string;
  /** `file:line:col` (or `file:lineStart-lineEnd`) if known. */
  sourceLoc?: string;
  /** The contributing view's `location.href`. */
  url?: string;
  /** The contributing view's role (e.g. `"code"`). */
  role?: string;
  /** Line count (for the long-selection header); derived from text if omitted. */
  lines?: number;
}

/** Free text contributed from another view. */
export interface TextContribution {
  kind: "text";
  text: string;
  role?: string;
}

export type SessionContribution = SelectionContribution | TextContribution;

/** Whether a selection contribution is short enough to inline. */
export function isShortSelection(c: SelectionContribution): boolean {
  return c.text.trim().length <= SHORT_SELECTION_CHARS;
}

/**
 * Format a contribution as plain turn text. Retained for **text**
 * contributions (they pass through) and as the reference wording of the
 * selection rendering; the host no longer calls this for selections — a
 * selection rides the stream as a structured `code-selection` event and
 * `composeIntent` renders it (same short/long rule) at lowering time.
 */
export function contributionToText(c: SessionContribution): string {
  if (c.kind === "text") {
    return c.text;
  }
  const loc = c.sourceLoc ? `\`${c.sourceLoc}\`` : "the selection";
  if (isShortSelection(c)) {
    return `Regarding ${loc}: \`${c.text.trim()}\``;
  }
  const n = c.lines ?? c.text.split("\n").length;
  return `Regarding ${loc} (${n} lines):\n\`\`\`\n${c.text}\n\`\`\``;
}
