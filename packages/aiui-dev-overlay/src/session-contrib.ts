/**
 * Contributions: what a non-host view (the code reader today) sends over the
 * session bus to add to the turn the app tab is building.
 *
 * A contribution rides a bus `publish` on {@link SESSION_CONTRIBUTION_TOPIC}. The
 * host (the multimodal turn) ingests it as turn text via `Engine.contribute`, so
 * it composes into the prompt exactly like spoken words and shows in the preview.
 *
 * The short/long rule (per the design): a **short** selection is pasted inline —
 * "regarding `file:line`: `code`" — the location and the code right there. A
 * **long** selection is put into context as a fenced block under its location
 * header. Either way the text lands in the prompt; the shape just keeps a short
 * ref legible and a long one out of the sentence.
 */

/** The bus topic contributions are published on. */
export const SESSION_CONTRIBUTION_TOPIC = "contribution";

/** At or below this many characters a selection is inlined; above it, fenced. */
export const SHORT_SELECTION_CHARS = 240;

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
 * Format a contribution as the turn text the host ingests. Short selections are
 * inlined with their location; long ones become a fenced block under a location
 * header. Free text passes through.
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
