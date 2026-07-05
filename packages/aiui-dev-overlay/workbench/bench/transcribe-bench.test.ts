import { describe, expect, it } from "vitest";
import { normalize, wer } from "./transcribe-bench";

describe("normalize", () => {
  it("lowercases, strips punctuation, splits words", () => {
    expect(normalize("Make the Baseline, curve — thicker!")).toEqual([
      "make",
      "the",
      "baseline",
      "curve",
      "thicker",
    ]);
  });
});

describe("wer", () => {
  it("is 0 for a perfect transcript regardless of case/punctuation", () => {
    expect(wer("Make the curve thicker.", "make the curve thicker")).toBe(0);
  });

  it("counts substitutions, insertions, deletions per reference word", () => {
    expect(wer("make the curve thicker", "make a curve thicker")).toBe(25); // 1 sub / 4
    expect(wer("make the curve thicker", "make the very curve thicker")).toBe(25); // 1 ins
    expect(wer("make the curve thicker", "make curve thicker")).toBe(25); // 1 del
    expect(wer("a b", "")).toBe(100);
  });
});
