/**
 * retime.ts — best-effort word timestamps for EDITED transcript text.
 *
 * The segment editor replaces a segment's text wholesale; the compiler's
 * interleave then reflows anchored shots against word timestamps
 * (`segment-replace` — see the pipeline). This module approximates those
 * timestamps for the new text from the old words' measured ones. Deliberately
 * simple (owner: "we don't have to make this overly complicated"):
 *
 *  - align old → new with the kit's `wordDiff` (the same LCS every diff
 *    surface uses), so a KEPT word keeps its measured start/end;
 *  - an INSERTED word interpolates linearly between its nearest kept
 *    anchors, splitting the gap evenly;
 *  - at the edges (before the first anchor / after the last), extrapolate by
 *    the segment's mean word duration;
 *  - a TOTAL rewrite (no anchors at all) spreads uniformly over the original
 *    words' span.
 *
 * Confidence (`logprob`) survives only on kept words — an edit is the user
 * speaking with their keyboard; the transcriber's uncertainty about typed
 * words would be a lie.
 */

import type { TranscriptWord } from "@habemus-papadum/aiui-lowering-pipeline";
import { wordDiff } from "@habemus-papadum/aiui-viz/modal";

/** Fallback duration when the old words carry no usable timings at all. */
const DEFAULT_WORD_MS = 300;

const tokenize = (text: string): string[] => text.split(/\s+/).filter(Boolean);

/** The mean measured duration of the old words (the extrapolation step). */
function meanDurationMs(words: readonly TranscriptWord[]): number {
  const timed = words.filter((w) => w.startMs !== undefined && w.endMs !== undefined);
  if (timed.length === 0) {
    return DEFAULT_WORD_MS;
  }
  const total = timed.reduce((sum, w) => sum + ((w.endMs ?? 0) - (w.startMs ?? 0)), 0);
  return Math.max(1, total / timed.length);
}

/**
 * Approximate word timestamps for `newText`, anchored on `oldWords`.
 * Pure; returns one {@link TranscriptWord} per whitespace token of `newText`.
 */
export function retimeWords(
  oldWords: readonly TranscriptWord[],
  newText: string,
): TranscriptWord[] {
  const newTokens = tokenize(newText);
  if (newTokens.length === 0) {
    return [];
  }
  const oldTokens = oldWords.map((w) => w.text);
  const mean = meanDurationMs(oldWords);

  // The kit's LCS, replayed against the WORD ARRAYS: "same" runs consume
  // both sides (kept words), "del" consumes old only, "add" new only.
  const runs = wordDiff(oldTokens.join(" "), newTokens.join(" "));
  const slots: Array<TranscriptWord | undefined> = new Array(newTokens.length).fill(undefined);
  let oldIndex = 0;
  let newIndex = 0;
  for (const run of runs) {
    const count = tokenize(run.text).length;
    if (run.kind === "same") {
      for (let k = 0; k < count; k++) {
        const old = oldWords[oldIndex + k];
        if (old !== undefined && newIndex + k < slots.length) {
          slots[newIndex + k] = { ...old, text: newTokens[newIndex + k] };
        }
      }
      oldIndex += count;
      newIndex += count;
    } else if (run.kind === "del") {
      oldIndex += count;
    } else {
      newIndex += count; // inserted words — filled below
    }
  }

  // Fill the gaps: interpolate between kept anchors; extrapolate at edges by
  // the mean duration; a TOTAL rewrite (one gap, no anchors on either side)
  // spreads uniformly over the original words' measured span.
  const spanStart = oldWords.find((w) => w.startMs !== undefined)?.startMs ?? 0;
  const lastTimed = [...oldWords].reverse().find((w) => w.endMs !== undefined);
  const spanEnd = lastTimed?.endMs;
  let i = 0;
  while (i < slots.length) {
    if (slots[i] !== undefined) {
      i++;
      continue;
    }
    let j = i;
    while (j < slots.length && slots[j] === undefined) {
      j++;
    }
    const gap = j - i;
    const prevEnd = i > 0 ? slots[i - 1]?.endMs : undefined;
    const nextStart = j < slots.length ? slots[j]?.startMs : undefined;
    let from: number;
    let to: number;
    if (prevEnd !== undefined && nextStart !== undefined) {
      // Between two kept anchors: split their gap evenly.
      [from, to] = [prevEnd, Math.max(nextStart, prevEnd)];
    } else if (prevEnd !== undefined) {
      // Trailing insert: extend past the last anchor by the mean duration.
      [from, to] = [prevEnd, prevEnd + gap * mean];
    } else if (nextStart !== undefined) {
      // Leading insert: back off from the first anchor, floored at zero.
      [from, to] = [Math.max(0, nextStart - gap * mean), nextStart];
    } else if (spanEnd !== undefined && spanEnd > spanStart) {
      // Total rewrite with a measured span: spread uniformly across it.
      [from, to] = [spanStart, spanEnd];
    } else {
      // No timing anywhere: synthesize from zero by the default duration.
      [from, to] = [spanStart, spanStart + gap * mean];
    }
    const step = (to - from) / gap || mean;
    for (let k = 0; k < gap; k++) {
      slots[i + k] = {
        text: newTokens[i + k],
        startMs: Math.round(from + k * step),
        endMs: Math.round(from + (k + 1) * step),
      };
    }
    i = j;
  }
  return slots as TranscriptWord[];
}
