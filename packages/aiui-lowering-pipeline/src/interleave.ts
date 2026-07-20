/**
 * Pass 4 of the compiler — the timestamp interleave and its pure helpers.
 * Splits each segment's text around the ANCHORED items that landed
 * mid-utterance — shots (anchored at their capture gesture) and app/code
 * selections (anchored at their add instant, 2026-07-20) — placing each at
 * the character offset the deltas (or word timestamps) had reached at its
 * anchor. A leaf: it depends only on ./types and declares its own narrow
 * input type so compose.ts's StreamFacts satisfies it structurally, keeping
 * the dependency edge one-way (compose → interleave).
 */
import type { ComposedItem, TranscriptWord } from "./types";

/**
 * The stream-wide facts pass 4 reads — exactly the three fields it
 * destructures. Declared here rather than imported from compose.ts so there is
 * no type cycle; scanStream's richer StreamFacts satisfies it structurally.
 */
export interface InterleaveFacts {
  windows: Map<number, { start: number; end?: number }>;
  deltaTimelines: Map<number, Array<{ at: number; len: number }>>;
  wordsBySegment: Map<number, TranscriptWord[]>;
}

/**
 * Pass 4 — the timestamp interleave: place anchored items INSIDE their
 * segment's text. An item that landed mid-window used to compose BEFORE that
 * segment's entire text (finals arrive late; position was arrival order).
 * With `takenAt` (a shot's capture-gesture wall-clock; a selection's add
 * instant) and either anchor the segment carries — word timestamps on its
 * final (the exact anchor, `wordOffsetAt`) or its delta timeline
 * (`deltaOffsetAt`) — the compiler, the ONLY place allowed to reorder the
 * accumulator, splits the segment's text at the offset that anchor had
 * reached at the item's moment, nudged to a word boundary. Fallbacks are
 * byte-identical to the old behavior: no takenAt (legacy streams), no
 * matching talk window (an idle shot, a between-utterances selection), or a
 * segment with NEITHER anchor (a REST/silent final with no word timestamps
 * and no deltas) → the item keeps its arrival position.
 *
 * Under `streaming` this runs against the PROVISIONAL run too, so a shot
 * lands in the live transcript as it is taken. The offset is stable as the
 * text grows: `deltaOffsetAt` reads the cumulative length at `takenAt + lag`,
 * and later deltas are all past that instant, so they extend the tail rather
 * than push the shot along.
 *
 * Deltas TRAIL speech by the transcriber's latency, so a naive
 * takenAt-vs-arrival comparison lands the split systematically EARLY —
 * the words you had already spoken at the gesture hadn't arrived yet
 * (observed ~1 s off in practice). {@link deltaLagEstimate} compensates
 * with a per-segment estimate measured from data the stream already
 * carries. Honest scope note: this is a research area, not a solved
 * problem — the estimate is coarse (see the helper's doc), and the right
 * long-term anchor is probably audio-time-aligned transcription.
 */
/** The item kinds the interleave may move: each carries a `takenAt` anchor. */
const ANCHORED_KINDS = new Set<ComposedItem["kind"]>(["shot", "app-selection", "code-selection"]);

export function interleavePass(items: ComposedItem[], facts: InterleaveFacts): void {
  const { windows, deltaTimelines, wordsBySegment } = facts;
  const anchored = new Map<number, ComposedItem[]>();
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (!ANCHORED_KINDS.has(item.kind) || item.takenAt === undefined) {
      continue;
    }
    const segment = segmentContaining(windows, item.takenAt);
    // Admit a segment that carries EITHER anchor the body can split on: a delta
    // timeline (the streaming preview's provisional runs) OR word timestamps on
    // its final. The committed fold composes from finals alone (deltas are never
    // appended to the event log — see intent-stt's onDelta), so a word-timestamped
    // realtime final has no delta timeline; gating on deltas alone left the exact
    // `wordOffsetAt` anchor unreachable and stacked every shot ahead of the text.
    if (segment === undefined || (!deltaTimelines.has(segment) && !wordsBySegment.has(segment))) {
      continue;
    }
    if (!items.some((t) => t.kind === "text" && t.segment === segment)) {
      continue; // the segment never produced text — nothing to split
    }
    items.splice(i, 1);
    anchored.set(segment, [item, ...(anchored.get(segment) ?? [])]);
  }
  if (anchored.size === 0) {
    return;
  }
  for (let i = items.length - 1; i >= 0; i--) {
    const target = items[i];
    if (target.kind !== "text" || target.segment === undefined) {
      continue;
    }
    const anchors = anchored.get(target.segment);
    if (anchors === undefined) {
      continue;
    }
    const text = target.text ?? "";
    const timeline = deltaTimelines.get(target.segment) ?? [];
    const lag = deltaLagEstimate(windows.get(target.segment), timeline);
    const words = wordsBySegment.get(target.segment);
    const windowStart = windows.get(target.segment)?.start;
    // Oldest anchor first; each split offset is nudged to the end of the word
    // it lands in (and past a sentence end just ahead), so an item never
    // interrupts a word — and rarely a sentence. Word timestamps, when
    // present, anchor exactly; the delta-timeline lag estimate is the
    // fallback.
    const placed: ComposedItem[] = [];
    // A provisional run stays provisional on both sides of the split — the
    // preview renders every run of a still-streaming segment dim, whether or
    // not an anchored item cut it in two.
    const run = (text: string): ComposedItem => ({
      kind: "text",
      text,
      segment: target.segment,
      ...(target.provisional ? { provisional: true } : {}),
    });
    let consumed = 0;
    for (const anchor of anchors.sort((a, b) => (a.takenAt ?? 0) - (b.takenAt ?? 0))) {
      const exact =
        words !== undefined && windowStart !== undefined
          ? wordOffsetAt(text, words, windowStart, anchor.takenAt ?? 0)
          : undefined;
      const offset = nudgeToBoundary(
        text,
        exact ?? deltaOffsetAt(timeline, (anchor.takenAt ?? 0) + lag),
      );
      const head = text.slice(consumed, Math.max(consumed, offset)).trim();
      if (head !== "") {
        placed.push(run(head));
      }
      placed.push(anchor);
      consumed = Math.max(consumed, offset);
    }
    const tail = text.slice(consumed).trim();
    if (tail !== "") {
      placed.push(run(tail));
    }
    items.splice(i, 1, ...placed);
  }
}

// ── the timestamp interleave's pure helpers ──────────────────────────────────

/**
 * How long after a talk window closes a shot still anchors to that segment
 * (placed after its text). Finals arrive well after the release; without
 * this grace a shot taken in that gap composes BEFORE the words it followed
 * (the event beat the final into the stream).
 */
const POST_WINDOW_ANCHOR_GRACE_MS = 3000;

/**
 * The delta-lag fallback/ceiling, in ms. `at` stamps are wall-clock
 * milliseconds by wire contract, so absolute bounds are legitimate here.
 */
const DEFAULT_DELTA_LAG_MS = 800;
const MAX_DELTA_LAG_MS = 2000;

/** The segment whose talk window contains `at` — or whose window closed
 * within {@link POST_WINDOW_ANCHOR_GRACE_MS} before it (the latest match
 * wins; an in-window match beats a post-window one). */
function segmentContaining(
  windows: ReadonlyMap<number, { start: number; end?: number }>,
  at: number,
): number | undefined {
  let found: number | undefined;
  let trailing: number | undefined;
  for (const [segment, window] of windows) {
    if (at >= window.start && (window.end === undefined || at <= window.end)) {
      found = segment;
    } else if (
      window.end !== undefined &&
      at > window.end &&
      at - window.end <= POST_WINDOW_ANCHOR_GRACE_MS
    ) {
      trailing = segment;
    }
  }
  return found ?? trailing;
}

/**
 * Estimate how far this segment's deltas TRAILED the speech they
 * transcribe, from data the stream already carries. Two observable anchors:
 *
 *  - **tail** — the last words are spoken at the window close (talk-end);
 *    the delta carrying them arrives one speech→text latency later. Clean:
 *    no onset contamination.
 *  - **head** — speech starts around the window open; the first delta
 *    arrives one latency later. Contaminated by the user's speech-onset
 *    delay (and the transcriber's warm-up), so it OVERestimates.
 *
 * Prefer the tail when it is measurable (deltas usually straggle past the
 * release), fall back to the head, then to a fixed default; clamp to a sane
 * band. Research note (deliberately unsolved here): the right long-term
 * anchor is per-word audio-offset alignment, which no vendor exposes today.
 */
function deltaLagEstimate(
  window: { start: number; end?: number } | undefined,
  timeline: ReadonlyArray<{ at: number; len: number }>,
): number {
  const first = timeline[0]?.at;
  const last = timeline[timeline.length - 1]?.at;
  if (window === undefined || first === undefined || last === undefined) {
    return DEFAULT_DELTA_LAG_MS;
  }
  const tail = window.end !== undefined ? last - window.end : Number.NEGATIVE_INFINITY;
  const head = first - window.start;
  const measured = tail > 0 ? tail : head;
  if (measured <= 0) {
    return DEFAULT_DELTA_LAG_MS;
  }
  return Math.min(measured, MAX_DELTA_LAG_MS);
}

/**
 * The cumulative text length the segment's deltas had reached by `at` — the
 * split offset a shot taken at that moment anchors to. Deltas carry
 * CUMULATIVE text, so the last sample at-or-before `at` is the answer; no
 * sample yet → 0 (the shot precedes the segment's words).
 */
function deltaOffsetAt(timeline: ReadonlyArray<{ at: number; len: number }>, at: number): number {
  let len = 0;
  for (const sample of timeline) {
    if (sample.at > at) {
      break;
    }
    len = sample.len;
  }
  return len;
}

/**
 * The EXACT interleave anchor: how many characters of `text` had been SPOKEN
 * by wall-clock `at`, from the transcriber's word timestamps. A word's
 * startMs is relative to the segment's first audio sample (the talk-start
 * instant, `windowStart`); the offset is the length of the words spoken
 * strictly before `at`, located against `text` by matching the words in
 * order (vendor word text and the final text can differ in spacing — the
 * search is per-word, tolerant). Undefined when no word carries a timestamp
 * (the caller falls back to the delta-timeline estimate).
 */
function wordOffsetAt(
  text: string,
  words: ReadonlyArray<TranscriptWord>,
  windowStart: number,
  at: number,
): number | undefined {
  let offset: number | undefined;
  let cursor = 0;
  for (const word of words) {
    if (word.startMs === undefined || word.text.trim() === "") {
      continue;
    }
    const found = text.indexOf(word.text, cursor);
    if (found === -1) {
      continue; // final text diverged from this word — keep aligning on the rest
    }
    if (windowStart + word.startMs > at) {
      return offset ?? 0; // this word was spoken after the gesture
    }
    cursor = found + word.text.length;
    offset = cursor;
  }
  return offset;
}

/** How far past the word end the boundary nudge will reach for a sentence
 * end. Small on purpose: snapping a shot past a whole clause would move it
 * further from the gesture than the latency error it exists to absorb. */
const SENTENCE_SNAP_CHARS = 24;

/**
 * Advance an offset to the end of the word it lands in (never split a
 * word) — and, when a sentence ends within {@link SENTENCE_SNAP_CHARS}
 * ahead, on past it: dictation pauses (and shots) cluster at sentence
 * boundaries, so the nearby period is more often the true seam than the
 * mid-sentence word the latency math landed on. Forward-only — never pull
 * a shot before words already spoken.
 */
function nudgeToBoundary(text: string, offset: number): number {
  if (offset <= 0) {
    return 0;
  }
  if (offset >= text.length) {
    return text.length;
  }
  let i = offset;
  while (i < text.length && !/\s/.test(text[i])) {
    i++;
  }
  // Already standing on a sentence seam? Stop. The lookahead below exists to
  // finish the sentence the gesture landed INSIDE — never to skip over a whole
  // one, which would carry the shot further from the gesture than the latency
  // error the nudge absorbs. (An offset landing exactly after "…a demo." would
  // otherwise swallow the next short sentence whole.)
  if (/[.!?]["')\]]?$/.test(text.slice(0, i))) {
    return i;
  }
  const ahead = text.slice(i, i + SENTENCE_SNAP_CHARS);
  const sentence = ahead.match(/^(.*?[.!?]["')\]]?)(\s|$)/);
  if (sentence !== null) {
    return i + sentence[1].length;
  }
  return i;
}
