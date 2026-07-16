import { describe, expect, it } from "vitest";
import { applyCorrectionToLines, applyPatch, wordDiff } from "./patch";

const patch = (body: string) =>
  `*** Begin Patch\n*** Update File: transcript\n${body}\n*** End Patch`;

describe("applyPatch", () => {
  const doc = [
    "make the base line curb thicker",
    "and move the legend below",
    "also label the peek",
  ];

  it("applies a single hunk located by context, not line numbers", () => {
    const out = applyPatch(
      doc,
      patch("@@\n-make the base line curb thicker\n+make the baseline curve thicker"),
    );
    expect(out).toEqual([
      "make the baseline curve thicker",
      "and move the legend below",
      "also label the peek",
    ]);
  });

  it("applies multiple hunks with surrounding context lines", () => {
    const out = applyPatch(
      doc,
      patch(
        "@@\n make the base line curb thicker\n-and move the legend below\n+and move the legend below the plot\n@@\n-also label the peek\n+also label the peak",
      ),
    );
    expect(out[1]).toBe("and move the legend below the plot");
    expect(out[2]).toBe("also label the peak");
  });

  it("can insert and delete lines", () => {
    const grew = applyPatch(doc, patch("@@\n and move the legend below\n+use two rows if tight"));
    expect(grew).toHaveLength(4);
    expect(grew[2]).toBe("use two rows if tight");

    const shrank = applyPatch(doc, patch("@@\n-also label the peek"));
    expect(shrank).toHaveLength(2);
  });

  it("falls back to whitespace-trimmed matching", () => {
    const out = applyPatch(["  padded line  "], patch("@@\n-padded line\n+fixed line"));
    expect(out).toEqual(["fixed line"]);
  });

  it("throws on bad grammar and on unmatched context", () => {
    expect(() => applyPatch(doc, "no markers")).toThrow(/not a V4A patch/);
    expect(() => applyPatch(doc, patch("@@\n-line that is not there\n+x"))).toThrow(
      /context not found/,
    );
  });
});

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
});

describe("applyCorrectionToLines — chunk scope", () => {
  it("the plain-replacement fallback searches only inside the scoped window", () => {
    const lines = ["the curb is long", "and wide", "another curb here"];
    const { lines: out, applied } = applyCorrectionToLines(lines, {
      original: "curb",
      instruction: "curve",
      scope: { fromLine: 2, toLine: 3 }, // the active chunk: only line 2
    });
    expect(applied).toBe(true);
    expect(out[0]).toBe("the curb is long"); // chunk 1 untouched
    expect(out[2]).toBe("another curve here");
  });

  it("no match inside the window → not applied, even when it exists outside", () => {
    const lines = ["the curb is long", "another line"];
    const { applied } = applyCorrectionToLines(lines, {
      original: "curb",
      instruction: "curve",
      scope: { fromLine: 1, toLine: 2 },
    });
    expect(applied).toBe(false);
  });
});
