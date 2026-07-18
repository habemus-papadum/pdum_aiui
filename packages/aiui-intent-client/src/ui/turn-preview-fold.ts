/**
 * turn-preview-fold.ts — the turn preview's pure derivation layer, no Solid
 * imports: composeIntent's first IR pass folded into keyed rows (buildPieces),
 * the turn-wide logprob range (logprobRangeOf), row keying (keyOf), and the
 * route-shortening helper. The component wraps buildPieces/logprobRangeOf in
 * memos over the per-turn reset gate; the fold itself is a pure function.
 */

import {
  type ComposedItem,
  composeIntent,
  type IntentEvent,
  type TranscriptWord,
} from "@habemus-papadum/aiui-lowering-pipeline";

/** A URL as path+query+hash — the origin is noise inside one tab's preview. */
export function shortRoute(url: string | undefined): string {
  if (url === undefined || url === "") {
    return "?";
  }
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}${u.hash}` || url;
  } catch {
    return url;
  }
}

/** A composed item's keyed-`<For>` identity (stable across re-folds). */
function keyOf(item: ComposedItem, index: number): string {
  switch (item.kind) {
    case "text":
      return item.segment !== undefined ? `text:${item.segment}` : `text:@${index}`;
    case "shot":
      return `shot:${item.marker ?? `@${index}`}`;
    case "app-selection":
      return `sel:${item.marker ?? `@${index}`}`;
    case "code-selection":
      return `code:${item.marker ?? `@${index}`}`;
    case "navigation":
      return `nav:@${index}`;
    case "tab-switch":
      return `tab:@${index}`;
  }
}

/** One preview row: a composed item plus its stable key (and, for a final
 * with confidence, its words — the heat row's data). */
export interface Piece {
  item: ComposedItem;
  key: string;
  words?: TranscriptWord[];
}

/**
 * Fold the current thread's events into keyed rows — composeIntent (the SAME
 * first IR pass the channel runs) plus the transcript-final word attachment
 * and the key uniquification. The `:w` heat re-key suffix is LOAD-BEARING:
 * words arriving must RE-KEY the row or the provisional run's plain shape
 * survives the final and the heat branch is unreachable. The per-turn reset
 * gate stays in the component's memo — this is the pure fold beneath it.
 */
export function buildPieces(events: IntentEvent[]): Piece[] {
  const items = composeIntent(events, "replace", { streaming: true }).items;
  const wordsBySegment = new Map<number, TranscriptWord[]>();
  for (const event of events) {
    if (event.type === "transcript-final" && event.words !== undefined) {
      wordsBySegment.set(event.segment, event.words);
    }
  }
  // Uniquify repeated keys (the compiler may split one segment's text
  // around a timestamp-anchored shot); the `:w` suffix is LOAD-BEARING —
  // words arriving must RE-KEY the row or the provisional run's plain
  // shape survives the final and the heat branch is unreachable.
  const seen = new Map<string, number>();
  return items.map((item, index) => {
    const base = keyOf(item, index);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    const words =
      item.kind === "text" && item.segment !== undefined
        ? wordsBySegment.get(item.segment)
        : undefined;
    const heat =
      words !== undefined &&
      n === 0 &&
      words.map((w) => w.text).join(" ").length >= (item.text ?? "").length;
    const key = `${n === 0 ? base : `${base}#${n}`}${heat ? ":w" : ""}`;
    return { item, key, ...(heat ? { words } : {}) };
  });
}

/** The turn-wide logprob range: heat normalizes against the turn's own
 * confidence distribution (absolute scales wash out across vendors). */
export function logprobRangeOf(pieces: Piece[]): { min: number; max: number } | undefined {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const piece of pieces) {
    for (const word of piece.words ?? []) {
      if (word.logprob !== undefined) {
        min = Math.min(min, word.logprob);
        max = Math.max(max, word.logprob);
      }
    }
  }
  return min < max ? { min, max } : undefined;
}
