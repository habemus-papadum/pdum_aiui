import type { SelectionSnapshot } from "@habemus-papadum/aiui-code";
import { describe, expect, it } from "vitest";
import {
  excerpt,
  selectionLineCount,
  selectionLoc,
  selectionToContribution,
} from "./reader-contribution";

const sel = (
  file: string,
  range: SelectionSnapshot["range"],
  text = "code",
): SelectionSnapshot => ({ file, range, text });

describe("selectionLoc", () => {
  it("formats a single-line selection as file:line:col (1-based)", () => {
    expect(
      selectionLoc(
        sel("pkg/a.py", { start: { line: 4, character: 2 }, end: { line: 4, character: 7 } }),
      ),
    ).toBe("pkg/a.py:5:3");
  });

  it("formats a multi-line selection as file:startLine-endLine (1-based)", () => {
    expect(
      selectionLoc(
        sel("pkg/a.py", { start: { line: 4, character: 0 }, end: { line: 9, character: 3 } }),
      ),
    ).toBe("pkg/a.py:5-10");
  });
});

describe("selectionLineCount", () => {
  it("counts a single line as 1", () => {
    expect(
      selectionLineCount(
        sel("a", { start: { line: 2, character: 0 }, end: { line: 2, character: 8 } }),
      ),
    ).toBe(1);
  });

  it("counts inclusive spanned lines", () => {
    expect(
      selectionLineCount(
        sel("a", { start: { line: 4, character: 0 }, end: { line: 9, character: 3 } }),
      ),
    ).toBe(6);
  });
});

describe("selectionToContribution", () => {
  it("builds a code-role selection contribution", () => {
    const c = selectionToContribution(
      sel(
        "pkg/a.py",
        { start: { line: 2, character: 0 }, end: { line: 2, character: 8 } },
        "return x",
      ),
      "http://localhost:5174/",
    );
    expect(c).toEqual({
      kind: "selection",
      text: "return x",
      sourceLoc: "pkg/a.py:3:1",
      url: "http://localhost:5174/",
      role: "code",
      lines: 1,
    });
  });
});

describe("excerpt", () => {
  it("collapses whitespace and trims", () => {
    expect(excerpt("  a\n  b  c ")).toBe("a b c");
  });

  it("truncates with an ellipsis past the cap", () => {
    expect(excerpt("x".repeat(100), 10)).toBe("xxxxxxxxx…");
  });

  it("leaves short text intact", () => {
    expect(excerpt("short", 10)).toBe("short");
  });
});
