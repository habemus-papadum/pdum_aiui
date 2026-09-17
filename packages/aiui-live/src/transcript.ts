/**
 * transcript.ts — fragments into something a person (or a backend) can read.
 *
 * Live sends `session.*_transcript.delta` as FRAGMENTS: a few words with
 * `start_ms`/`end_ms` on the session timeline, no item ids, no turn
 * boundaries. Grouping by silence gap is the honest reconstruction: two
 * fragments belong to one utterance when the pause between them is shorter
 * than {@link DEFAULT_GAP_MS}. The number is a display choice, not a fact
 * about the model — keep it adjustable.
 */

import type { TranscriptSegment, Utterance } from "./types";

export const DEFAULT_GAP_MS = 800;

export class TranscriptTrack {
  readonly segments: TranscriptSegment[] = [];
  private cachedGap = -1;
  private cached: Utterance[] = [];

  constructor(private readonly gapMs = DEFAULT_GAP_MS) {}

  push(segment: TranscriptSegment): void {
    this.segments.push(segment);
    this.cachedGap = -1;
  }

  /** Everything, concatenated (fragments already carry their own spacing). */
  text(): string {
    return joinFragments(this.segments.map((segment) => segment.text));
  }

  /** ms since connect of the last fragment, or undefined. */
  lastT(): number | undefined {
    return this.segments.at(-1)?.t;
  }

  utterances(gapMs = this.gapMs): Utterance[] {
    if (gapMs === this.cachedGap) {
      return this.cached;
    }
    this.cached = groupUtterances(this.segments, gapMs);
    this.cachedGap = gapMs;
    return this.cached;
  }

  /** The utterances whose FIRST fragment arrived after `t` (ms since connect). */
  since(t: number): Utterance[] {
    return this.utterances().filter((utterance) => utterance.t > t);
  }

  /** The last `n` utterances' text, oldest first. */
  tail(n: number): string {
    return this.utterances()
      .slice(-n)
      .map((utterance) => utterance.text)
      .join("\n");
  }

  reset(): void {
    this.segments.length = 0;
    this.cachedGap = -1;
  }
}

/** Fragments already include leading spaces where the vendor meant them; a
 * fragment that starts with a letter after one ending in a letter gets one. */
export function joinFragments(parts: readonly string[]): string {
  let out = "";
  for (const part of parts) {
    if (out !== "" && /\w$/.test(out) && /^\w/.test(part)) {
      out += " ";
    }
    out += part;
  }
  return out.trim();
}

export function groupUtterances(segments: readonly TranscriptSegment[], gapMs: number) {
  const out: Utterance[] = [];
  let current: { parts: string[]; startMs: number; endMs: number; t: number; tEnd: number } | null =
    null;
  for (const segment of segments) {
    const startMs: number = segment.startMs ?? current?.endMs ?? 0;
    const endMs: number = segment.endMs ?? startMs;
    if (current !== null && startMs - current.endMs <= gapMs) {
      current.parts.push(segment.text);
      current.endMs = Math.max(current.endMs, endMs);
      current.tEnd = segment.t;
      continue;
    }
    if (current !== null) {
      out.push(finish(current));
    }
    current = { parts: [segment.text], startMs, endMs, t: segment.t, tEnd: segment.t };
  }
  if (current !== null) {
    out.push(finish(current));
  }
  return out;
}

function finish(group: {
  parts: string[];
  startMs: number;
  endMs: number;
  t: number;
  tEnd: number;
}): Utterance {
  return {
    text: joinFragments(group.parts),
    startMs: group.startMs,
    endMs: group.endMs,
    t: group.t,
    tEnd: group.tEnd,
  };
}

/**
 * Interleave two tracks into one chronological script — the seed for a
 * resumed session, and the context a backend reads. Session-timeline order
 * (start_ms), user first on ties.
 */
export function interleave(
  user: readonly Utterance[],
  assistant: readonly Utterance[],
): Array<{ role: "user" | "assistant"; text: string; startMs: number }> {
  const merged = [
    ...user.map((utterance) => ({ role: "user" as const, ...utterance })),
    ...assistant.map((utterance) => ({ role: "assistant" as const, ...utterance })),
  ];
  merged.sort((a, b) => a.startMs - b.startMs || (a.role === "user" ? -1 : 1));
  return merged.map(({ role, text, startMs }) => ({ role, text, startMs }));
}
