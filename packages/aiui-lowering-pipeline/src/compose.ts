/**
 * The compiler's core: {@link composeIntent} and passes 1-3 (scan → place →
 * corrections), the multi-pass fold from a thread's IntentEvent stream to the
 * lowered prompt body. Pass 4 (the timestamp interleave) is ./interleave and
 * pass 5 (render) is ./render, both imported below; ComposedItem /
 * ComposedIntent / ComposeOptions live in ./types.
 */
import { interleavePass } from "./interleave";
import { applyCorrectionToLines } from "./patch";
import { renderPrompt } from "./render";
import type {
  ComposedIntent,
  ComposedItem,
  ComposeOptions,
  IntentEvent,
  TranscriptWord,
} from "./types";

/**
 * Fold the current thread's events into the composed intent. Pure — the
 * inspector re-runs it on every event, which makes the behavior directly
 * observable while you interact (and trivially unit-testable).
 *
 * Structured as a MULTI-PASS lowering (owner, 2026-07-14 — "as if you're a
 * compiler engineer"), each pass a named function over an explicit IR:
 *
 *  1. **scan** — one walk over the stream collecting every stream-wide fact
 *     later passes consult ({@link StreamFacts}): drops, talk windows, delta
 *     timelines, word timestamps, and segment REPLACEMENTS (latest-wins,
 *     respecting deletes — the segment editor's `segment-replace`).
 *  2. **place** — append items in stream order. A replaced segment's text is
 *     superseded IN PLACE: the item sits where the segment's first placer
 *     (its final, normally) sits, carrying the replacement text.
 *  3. **corrections** — the spoken-correction patches against the
 *     transcript-as-lines (unchanged semantics; `replace` policy only).
 *  4. **interleave** — the timestamp reflow: anchored items (shots by their
 *     capture gesture, selections by their add instant) move INSIDE their
 *     segment's text, split at word-timestamp offsets. Replacements
 *     reflow here for free: their re-timestamped words landed in
 *     {@link StreamFacts.wordsBySegment} during the scan.
 *  5. **render** — transcript + the lowered prompt body.
 *
 * Correction semantics under `replace`: each correction rewrites the *first*
 * remaining occurrence of its original text (ranges were lassoed against a
 * live preview; original-text anchoring survives earlier rewrites better
 * than absolute offsets). Under `note`, corrections append as instructions
 * for the downstream lowering model instead.
 */
export function composeIntent(
  events: IntentEvent[],
  policy: "replace" | "note" = "replace",
  options: ComposeOptions = {},
): ComposedIntent {
  let start = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === "thread-open") {
      start = i;
      break;
    }
  }
  const scope = start === -1 ? events : events.slice(start);

  const facts = scanStream(scope);
  const { items, corrections } = placeItems(scope, facts, options);
  applyCorrectionsPass(items, corrections, policy);
  interleavePass(items, facts);
  return renderPrompt(items, corrections, policy, options);
}

/**
 * Pass 1's IR: every stream-wide fact the later passes consult. One walk
 * builds it; nothing after the scan re-reads the raw stream for facts.
 */
interface StreamFacts {
  /** Retracted markers (the preview's ✕) — the place pass skips them. */
  droppedShots: Set<string>;
  droppedSelections: Set<string>;
  droppedCode: Set<string>;
  /** Each segment's talk window (wall-clock bounds) — the interleave's map
   * from a shot's `takenAt` to its segment. */
  windows: Map<number, { start: number; end?: number }>;
  /** Each segment's `transcript-delta` timeline — (arrival, cumulative
   * length) samples the interleave's fallback anchoring reads. */
  deltaTimelines: Map<number, Array<{ at: number; len: number }>>;
  /** Streaming mode: the latest cumulative delta text per segment. */
  lastDeltaText: Map<number, string>;
  /** Segments whose provisional run is superseded (a final arrived — or a
   * replacement did: an edited segment is definitionally not in flight). */
  finalizedSegments: Set<number>;
  /** Segments that have a REAL final in scope (place-position bookkeeping:
   * a replacement places at its segment's first final when one exists). */
  finalsInScope: Set<number>;
  /** Word-level timestamps per segment, latest-wins — the PRECISE interleave
   * anchor. A replacement's re-timestamped words land here, which is what
   * makes the reflow of an edited segment free. */
  wordsBySegment: Map<number, TranscriptWord[]>;
  /** The segment editor's replacements, latest-wins per segment. */
  replacements: Map<number, { text: string; words?: TranscriptWord[] }>;
}

/** Pass 1 — scan: one walk, all facts. */
function scanStream(scope: IntentEvent[]): StreamFacts {
  const facts: StreamFacts = {
    droppedShots: new Set(),
    droppedSelections: new Set(),
    droppedCode: new Set(),
    windows: new Map(),
    deltaTimelines: new Map(),
    lastDeltaText: new Map(),
    finalizedSegments: new Set(),
    finalsInScope: new Set(),
    wordsBySegment: new Map(),
    replacements: new Map(),
  };
  for (const event of scope) {
    if (event.type === "shot-drop") {
      facts.droppedShots.add(event.marker);
    } else if (event.type === "app-selection-drop" && event.marker !== undefined) {
      facts.droppedSelections.add(event.marker);
    } else if (event.type === "code-selection-drop") {
      facts.droppedCode.add(event.marker);
    } else if (event.type === "talk-start") {
      facts.windows.set(event.segment, { start: event.at });
    } else if (event.type === "talk-end") {
      const window = facts.windows.get(event.segment);
      if (window !== undefined) {
        window.end = event.at;
      }
    } else if (event.type === "transcript-delta") {
      const timeline = facts.deltaTimelines.get(event.segment) ?? [];
      timeline.push({ at: event.at, len: event.text.length });
      facts.deltaTimelines.set(event.segment, timeline);
      facts.lastDeltaText.set(event.segment, event.text);
    } else if (event.type === "transcript-final") {
      if (!event.correction) {
        facts.finalizedSegments.add(event.segment);
        facts.finalsInScope.add(event.segment);
      }
      if (event.words !== undefined) {
        facts.wordsBySegment.set(event.segment, event.words);
      }
    } else if (event.type === "segment-replace") {
      // Latest-wins per segment. Words supersede the transcriber's (they
      // re-anchor the interleave); absent words keep the originals — the
      // old anchors are still the best approximation available.
      facts.replacements.set(event.segment, {
        text: event.text,
        ...(event.words !== undefined ? { words: event.words } : {}),
      });
      if (event.words !== undefined) {
        facts.wordsBySegment.set(event.segment, event.words);
      }
      facts.finalizedSegments.add(event.segment);
    }
  }
  return facts;
}

/** Pass 2 — place: items in stream order (replacements supersede in place). */
function placeItems(
  scope: IntentEvent[],
  facts: StreamFacts,
  options: ComposeOptions,
): { items: ComposedItem[]; corrections: ComposedIntent["corrections"] } {
  const items: ComposedItem[] = [];
  const corrections: ComposedIntent["corrections"] = [];
  // App selections are POSITIONAL items, marker-keyed latest-wins. The engine
  // mints a fresh marker per add now (owner, 2026-07-20 — the refinement rule
  // is retired), so live streams never share a marker; the fold is kept for
  // REPLAYED refinement-era traces (same marker twice → the first event's
  // position, the latest payload). Markerless events (pre-marker traces)
  // share one legacy slot, reproducing the old single-selection latest-wins.
  const LEGACY_SELECTION_KEY = "";
  const selectionByKey = new Map<string, ComposedItem>();
  /** Streaming mode: segments whose provisional run is already in `items`. */
  const provisionalPlaced = new Set<number>();
  /** Replaced segments already placed (first placer wins the position). */
  const replacedPlaced = new Set<number>();

  /** The one text item a replaced segment gets, wherever its first placer
   * sits. Returns true when it placed (or already had) the item. */
  const placeReplaced = (segment: number): boolean => {
    const replacement = facts.replacements.get(segment);
    if (replacement === undefined) {
      return false;
    }
    if (!replacedPlaced.has(segment)) {
      replacedPlaced.add(segment);
      items.push({ kind: "text", text: replacement.text, segment });
    }
    return true;
  };

  for (const event of scope) {
    if (event.type === "transcript-delta") {
      // The words still being spoken, as ONE run claiming the stream position
      // of the segment's first delta — so a shot taken mid-utterance composes
      // after it and the interleave below can split it. Later deltas mutate
      // that run's text rather than appending rows. Nothing here runs unless
      // the caller asked for it, and a finalized segment ignores it entirely:
      // the final's own item is the truth.
      if (!options.streaming || facts.finalizedSegments.has(event.segment)) {
        continue;
      }
      const text = facts.lastDeltaText.get(event.segment) ?? "";
      if (provisionalPlaced.has(event.segment) || text.trim() === "") {
        continue;
      }
      provisionalPlaced.add(event.segment);
      items.push({ kind: "text", text, segment: event.segment, provisional: true });
    } else if (event.type === "transcript-final" && !event.correction) {
      // One item per segment, deliberately unmerged: segments-as-lines is the
      // document shape the correction patches (and the corrector model) see.
      // A REPLACED segment's text supersedes here, in this final's position.
      if (!placeReplaced(event.segment)) {
        items.push({ kind: "text", text: event.text, segment: event.segment });
      }
    } else if (event.type === "segment-replace") {
      // Normally the segment's final placed it already (above). A replacement
      // for a segment with NO final in scope (an edited contribution whose
      // final fell out of the window) places at its own stream position.
      if (!facts.finalsInScope.has(event.segment)) {
        placeReplaced(event.segment);
      }
    } else if (event.type === "app-selection") {
      if (event.marker !== undefined && facts.droppedSelections.has(event.marker)) {
        continue;
      }
      const key = event.marker ?? LEGACY_SELECTION_KEY;
      const next: ComposedItem = {
        kind: "app-selection",
        text: event.text,
        // The add instant — the timestamp interleave's anchor (like a shot's
        // capture gesture): a selection made mid-utterance splits the
        // segment's text at the words spoken by that moment.
        takenAt: event.at,
        ...(event.sourceLoc !== undefined ? { sourceLoc: event.sourceLoc } : {}),
        ...(event.cell !== undefined ? { cell: event.cell } : {}),
        ...(event.cellLoc !== undefined ? { cellLoc: event.cellLoc } : {}),
        ...(event.tex !== undefined ? { tex: event.tex } : {}),
        ...(event.url !== undefined ? { url: event.url } : {}),
        ...(event.tab !== undefined ? { tab: event.tab } : {}),
        ...(event.marker !== undefined ? { marker: event.marker } : {}),
      };
      const existing = selectionByKey.get(key);
      if (existing !== undefined) {
        items[items.indexOf(existing)] = next; // supersede in place
      } else {
        items.push(next);
      }
      selectionByKey.set(key, next);
    } else if (event.type === "app-selection-drop") {
      // Marker'd drops were pre-collected in the scan; a markerless drop
      // (pre-marker traces) retracts the most recent still-carried selection.
      if (event.marker === undefined) {
        for (let i = items.length - 1; i >= 0; i--) {
          if (items[i].kind === "app-selection") {
            selectionByKey.delete(items[i].marker ?? LEGACY_SELECTION_KEY);
            items.splice(i, 1);
            break;
          }
        }
      }
    } else if (
      event.type === "code-selection" &&
      !(event.marker !== undefined && facts.droppedCode.has(event.marker))
    ) {
      items.push({
        kind: "code-selection",
        text: event.text,
        // The add instant (client ingest of the reader's contribution) — the
        // interleave anchor, same as an app selection's.
        takenAt: event.at,
        ...(event.sourceLoc !== undefined ? { sourceLoc: event.sourceLoc } : {}),
        ...(event.url !== undefined ? { url: event.url } : {}),
        ...(event.tab !== undefined ? { tab: event.tab } : {}),
        lines: event.lines ?? event.text.split("\n").length,
        ...(event.marker !== undefined ? { marker: event.marker } : {}),
      });
    } else if (event.type === "navigation") {
      // A positional boundary: everything composed before it happened on
      // `from`, everything after on `to`. Rendering is the compiler's call
      // (renderNavigation, in ./render) — the event travels structured.
      items.push({
        kind: "navigation",
        from: event.from,
        to: event.to,
        ...(event.tab !== undefined ? { tab: event.tab } : {}),
      });
    } else if (event.type === "tab-switch") {
      // The sibling boundary: a different TAB, not the same tab navigating.
      // Same positional attribution; renderTabSwitch (in ./render) phrases it as a switch.
      items.push({
        kind: "tab-switch",
        from: event.from,
        to: event.to,
        ...(event.fromTab !== undefined ? { fromTab: event.fromTab } : {}),
        ...(event.toTab !== undefined ? { toTab: event.toTab } : {}),
        ...(event.tab !== undefined ? { tab: event.tab } : {}),
      });
    } else if (event.type === "shot" && !facts.droppedShots.has(event.marker)) {
      items.push({
        kind: "shot",
        marker: event.marker,
        thumb: event.thumb,
        path: event.path,
        components: event.components,
        ...(event.viewport ? { viewport: true } : {}),
        ...(event.takenAt !== undefined ? { takenAt: event.takenAt } : {}),
        ...(event.share !== undefined ? { share: event.share } : {}),
        ...(event.origin !== undefined ? { origin: event.origin } : {}),
      });
    } else if (event.type === "correction") {
      corrections.push({
        original: event.original,
        instruction: event.instruction,
        applied: false,
        patch: event.patch,
        ...(event.scope !== undefined ? { scope: event.scope } : {}),
      });
    } else if (event.type === "correction-undo") {
      // Escape in the correction box: pop the most recent still-active
      // correction. Order matters — corrections apply sequentially, so only
      // LIFO undo keeps the remaining stack coherent.
      corrections.pop();
    }
  }
  return { items, corrections };
}

/** Pass 3 — spoken-correction patches against the transcript-as-lines. */
function applyCorrectionsPass(
  items: ComposedItem[],
  corrections: ComposedIntent["corrections"],
  policy: "replace" | "note",
): void {
  if (policy !== "replace" || corrections.length === 0) {
    return;
  }
  // Corrections are patches against the transcript-as-lines (one text run
  // per line — the same document shape the corrector model saw).
  const textIndexes = items
    .map((item, index) => (item.kind === "text" ? index : -1))
    .filter((index) => index !== -1);
  let lines = textIndexes.map((index) => items[index].text ?? "");
  for (const correction of corrections) {
    const result = applyCorrectionToLines(lines, correction);
    lines = result.lines;
    correction.applied = result.applied;
  }
  // Map lines back onto the interleave: 1:1 while both last, extra lines
  // append as a trailing run, vanished lines drop their runs.
  for (let k = 0; k < Math.min(lines.length, textIndexes.length); k++) {
    items[textIndexes[k]].text = lines[k];
  }
  if (lines.length > textIndexes.length) {
    items.push({ kind: "text", text: lines.slice(textIndexes.length).join(" ") });
  } else if (lines.length < textIndexes.length) {
    const dropped = new Set(textIndexes.slice(lines.length));
    for (let index = items.length - 1; index >= 0; index--) {
      if (dropped.has(index)) {
        items.splice(index, 1);
      }
    }
  }
}
