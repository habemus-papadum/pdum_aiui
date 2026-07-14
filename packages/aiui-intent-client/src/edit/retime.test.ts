// @vitest-environment jsdom
/**
 * retime.test.ts — the segment editor's timestamp approximation. The whole
 * contract: kept words keep their MEASURED times (that is what keeps shots
 * anchored through an edit); everything else is a documented approximation.
 */
import type { TranscriptWord } from "@habemus-papadum/aiui-dev-overlay/intent-pipeline";
import { describe, expect, it } from "vitest";
import { retimeWords } from "./retime";

const w = (text: string, startMs: number, endMs: number, logprob?: number): TranscriptWord => ({
  text,
  startMs,
  endMs,
  ...(logprob !== undefined ? { logprob } : {}),
});

const ORIGINAL = [
  w("make", 0, 400, -0.1),
  w("the", 400, 700, -0.2),
  w("legend", 700, 1200, -2.1),
  w("wider", 1600, 2000, -0.3),
];

describe("retimeWords", () => {
  it("kept words keep their measured times; the fixed word inherits the gap", () => {
    const out = retimeWords(ORIGINAL, "make the caption wider");
    expect(out.map((x) => x.text)).toEqual(["make", "the", "caption", "wider"]);
    expect(out[0]).toMatchObject({ startMs: 0, endMs: 400 });
    expect(out[1]).toMatchObject({ startMs: 400, endMs: 700 });
    // "caption" replaced "legend": interpolated between "the" (ends 700) and
    // "wider" (starts 1600) — inside the slot the old word occupied.
    expect(out[2].startMs).toBe(700);
    expect(out[2].endMs).toBe(1600);
    expect(out[3]).toMatchObject({ startMs: 1600, endMs: 2000 });
  });

  it("keeps confidence only on kept words — typed words carry no logprob", () => {
    const out = retimeWords(ORIGINAL, "make the caption wider");
    expect(out[0].logprob).toBe(-0.1);
    expect(out[2].logprob).toBeUndefined(); // the user's fix is not the model's guess
  });

  it("splits a multi-word insert evenly across the anchor gap", () => {
    const out = retimeWords(ORIGINAL, "make the small blue legend wider");
    // "small blue" inserted between "the" (ends 700) and "legend" (starts 700):
    // zero-width gap degrades to the mean duration — monotonic, never NaN.
    expect(out.map((x) => x.text)).toEqual(["make", "the", "small", "blue", "legend", "wider"]);
    for (const word of out) {
      expect(Number.isFinite(word.startMs)).toBe(true);
      expect((word.endMs ?? 0) >= (word.startMs ?? 0)).toBe(true);
    }
    expect(out[4]).toMatchObject({ startMs: 700, endMs: 1200 }); // legend kept
  });

  it("extends a trailing insert past the last anchor by the mean duration", () => {
    const out = retimeWords(ORIGINAL, "make the legend wider please now");
    const mean = (400 + 300 + 500 + 400) / 4;
    expect(out[4].startMs).toBe(2000);
    expect(out[4].endMs).toBe(2000 + mean);
    expect(out[5].endMs).toBe(2000 + 2 * mean);
  });

  it("backs a leading insert off the first anchor, floored at zero", () => {
    const out = retimeWords(ORIGINAL, "please make the legend wider");
    expect(out[0].text).toBe("please");
    // The first anchor starts at 0, so the back-off floors: the zero-width
    // window degrades to one mean duration (never negative, never NaN).
    expect(out[0].startMs).toBe(0);
    expect(Number.isFinite(out[0].endMs)).toBe(true);
    expect(out[1]).toMatchObject({ text: "make", startMs: 0, endMs: 400 }); // kept
  });

  it("a TOTAL rewrite spreads uniformly over the original span", () => {
    const out = retimeWords(ORIGINAL, "completely different words here");
    expect(out).toHaveLength(4);
    expect(out[0].startMs).toBe(0);
    expect(out[3].endMs).toBe(2000);
    expect(out[1].startMs).toBe(out[0].endMs);
  });

  it("no old timing at all synthesizes monotonic times from zero", () => {
    const out = retimeWords([{ text: "untimed" }], "some new words");
    expect(out).toHaveLength(3);
    expect(out[0].startMs).toBe(0);
    for (let i = 1; i < out.length; i++) {
      expect(out[i].startMs).toBe(out[i - 1].endMs);
    }
  });

  it("empty text returns no words", () => {
    expect(retimeWords(ORIGINAL, "   ")).toEqual([]);
  });
});
