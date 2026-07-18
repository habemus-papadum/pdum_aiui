/**
 * The prompt linter's **injection label grammar** — the bracketed text items
 * the sidecar feeds the live session so speech can reference on-screen
 * things: `[selection sel_2: …]` arrivals/updates, and retractions. The same
 * grammar family as `[image shot_N]` and `[transcript seg_N: …]`, so the
 * persona (LINTER_INSTRUCTIONS) describes ONE labeling rule.
 *
 * Historical note: this module also held `resolveSegments` — the
 * composer-era resolver that re-attached withheld shot/selection metadata to
 * the model's `submit_intent` segments. That path died with the
 * model-composes submode (the compiler composes everywhere); the labels
 * below are the surviving half.
 */
/**
 * What the channel keeps keyed by a selection's marker (`sel_N` / `code_N`) —
 * the latest event payload under that marker (a superseding re-emit replaces
 * it), never sent to the live model beyond the clipped injection label. A
 * drop is announced to the model via {@link selectionRetractionLabel}; the
 * compiler composes the committed prompt, so a retracted id can never leak
 * into the body.
 */
export interface SelectionEntry {
  /** Which selection kind — picks the rendering (app: prose quote; code: fenced). */
  kind: "app" | "code";
  /** The latest payload (the `ComposedItem` subset the shared renderings read). */
  item: {
    text: string;
    sourceLoc?: string;
    cell?: string;
    tex?: string;
    lines?: number;
    url?: string;
  };
}

// ── the injection label grammar (mirrors `[image shot_N]`) ───────────────────

/**
 * How much selection text rides the live injection before clipping. Selections
 * can be arbitrarily long and instructions/context are billed every turn; the
 * clipped excerpt is only there to ground deictic speech ("this gradient") —
 * the FULL text always enters the committed prompt through the compiler's
 * positional `app-selection`/`code-selection` events, never from here.
 */
export const SELECTION_EXCERPT_CHARS = 160;

/** Clip a selection's text for the injection label, marking the cut honestly. */
function excerptOf(text: string): { excerpt: string; clipped: boolean } {
  const trimmed = text.trim();
  return trimmed.length <= SELECTION_EXCERPT_CHARS
    ? { excerpt: trimmed, clipped: false }
    : { excerpt: `${trimmed.slice(0, SELECTION_EXCERPT_CHARS)}…`, clipped: true };
}

/**
 * The bracketed text item injected into the live conversation when a selection
 * arrives (or re-arrives under the same marker — `updated`). Same grammar family
 * as `[image shot_N]`, so the instructions describe one labeling rule:
 *
 *   `[selection sel_2: "gradient stops" — on-screen selection authored at src/Legend.tsx:41:8]`
 *   `[selection sel_2 updated: "gradient stops and labels" — on-screen selection …]`
 *   `[selection code_1: src/c.ts:12 — 3 lines of code the human contributed: \`…\` (clipped)]`
 *
 * A markerless selection (pre-marker clients) injects without an id — still
 * grounding, just not referenceable. Attribution beyond the locator (cell, TeX)
 * is deliberately withheld here — the compiler's positional events carry it
 * into the committed prompt.
 */
export function selectionInjectionLabel(
  marker: string | undefined,
  entry: SelectionEntry,
  updated: boolean,
): string {
  const id = marker !== undefined ? ` ${marker}` : "";
  const phase = updated ? " updated" : "";
  const { excerpt, clipped } = excerptOf(entry.item.text);
  const cut = clipped ? " (clipped)" : "";
  if (entry.kind === "code") {
    const n = entry.item.lines ?? entry.item.text.split("\n").length;
    const where = entry.item.sourceLoc !== undefined ? `${entry.item.sourceLoc} — ` : "";
    const lines = `${n} ${n === 1 ? "line" : "lines"} of code the human contributed`;
    return `[selection${id}${phase}: ${where}${lines}: \`${excerpt}\`${cut}]`;
  }
  const authored = entry.item.sourceLoc !== undefined ? ` authored at ${entry.item.sourceLoc}` : "";
  return `[selection${id}${phase}: "${excerpt}"${cut} — on-screen selection${authored}]`;
}

/**
 * The bracketed retraction item injected when a selection is dropped. The
 * conversation is append-only — the model saw the selection, so the honest move
 * is an explicit "disregard" (exactly the advisory shot retraction); the
 * compiler keeps the retracted selection out of the committed body.
 */
export function selectionRetractionLabel(marker: string | undefined): string {
  return marker !== undefined
    ? `[selection ${marker} retracted — disregard it]`
    : "[selection retracted — disregard it]";
}
