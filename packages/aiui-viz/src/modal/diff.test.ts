// @vitest-environment node
import { describe, expect, it } from "vitest";
import { wordDiff } from "./diff";

// wordDiff moved here verbatim from the overlay's intent pipeline; these
// cases came with it (the pipeline re-exports it, so its own tests keep
// passing there). Pure string → runs, node environment on purpose.
describe("wordDiff", () => {
  it("marks substitutions as del+add runs between same runs", () => {
    expect(wordDiff("make the curb thicker", "make the curve thicker")).toEqual([
      { kind: "same", text: "make the" },
      { kind: "del", text: "curb" },
      { kind: "add", text: "curve" },
      { kind: "same", text: "thicker" },
    ]);
  });

  it("handles pure insertions and deletions at the edges", () => {
    expect(wordDiff("a b", "a b c")).toEqual([
      { kind: "same", text: "a b" },
      { kind: "add", text: "c" },
    ]);
    expect(wordDiff("x a b", "a b")).toEqual([
      { kind: "del", text: "x" },
      { kind: "same", text: "a b" },
    ]);
  });

  it("returns one same run for identical strings", () => {
    expect(wordDiff("same text", "same text")).toEqual([{ kind: "same", text: "same text" }]);
  });

  it("treats whitespace as separation only — runs re-join with single spaces", () => {
    expect(wordDiff("a \t b", "a b")).toEqual([{ kind: "same", text: "a b" }]);
    expect(wordDiff("  padded  ", "padded")).toEqual([{ kind: "same", text: "padded" }]);
  });

  it("empty sides diff to a pure add, a pure del, or nothing at all", () => {
    expect(wordDiff("", "brand new words")).toEqual([{ kind: "add", text: "brand new words" }]);
    expect(wordDiff("all gone now", "")).toEqual([{ kind: "del", text: "all gone now" }]);
    expect(wordDiff("", "")).toEqual([]);
  });
});
