import { describe, expect, it } from "vitest";
import {
  contributionToText,
  isShortSelection,
  type SelectionContribution,
  SHORT_SELECTION_CHARS,
} from "./session-contrib";

const sel = (over: Partial<SelectionContribution> = {}): SelectionContribution => ({
  kind: "selection",
  text: "Vec3",
  sourceLoc: "web/src/vec3.ts:21",
  ...over,
});

describe("session-contrib", () => {
  it("inlines a short selection with its location", () => {
    const text = contributionToText(sel({ text: "class Vec3 {}" }));
    expect(text).toBe("Regarding `web/src/vec3.ts:21`: `class Vec3 {}`");
  });

  it("fences a long selection under a location header with a line count", () => {
    const body = Array.from({ length: 30 }, (_, i) => `line ${i} of the selected code`).join("\n");
    expect(body.length).toBeGreaterThan(SHORT_SELECTION_CHARS);
    const text = contributionToText(sel({ text: body, lines: 30 }));
    expect(text.startsWith("Regarding `web/src/vec3.ts:21` (30 lines):\n```\n")).toBe(true);
    expect(text.endsWith("\n```")).toBe(true);
    expect(text).toContain(body);
  });

  it("derives the line count from the text when omitted", () => {
    const body = `${"x".repeat(SHORT_SELECTION_CHARS + 1)}\nsecond\nthird`;
    expect(contributionToText(sel({ text: body }))).toContain("(3 lines)");
  });

  it("falls back to 'the selection' with no sourceLoc", () => {
    expect(contributionToText(sel({ text: "hi", sourceLoc: undefined }))).toBe(
      "Regarding the selection: `hi`",
    );
  });

  it("passes free text through unchanged", () => {
    expect(contributionToText({ kind: "text", text: "make this wider" })).toBe("make this wider");
  });

  it("classifies short vs long by trimmed length", () => {
    expect(isShortSelection(sel({ text: "  short  " }))).toBe(true);
    expect(isShortSelection(sel({ text: "x".repeat(SHORT_SELECTION_CHARS + 1) }))).toBe(false);
  });
});
