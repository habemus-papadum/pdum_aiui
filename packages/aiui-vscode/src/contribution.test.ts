import { describe, expect, it } from "vitest";
import {
  type EditorSelection,
  selectionLineCount,
  selectionLoc,
  selectionToContribution,
} from "./contribution";

const single: EditorSelection = {
  file: "src/foo.ts",
  text: "const x = 1;",
  startLine: 11,
  startCharacter: 4,
  endLine: 11,
  endCharacter: 16,
};

const multi: EditorSelection = {
  file: "src/foo.ts",
  text: "a\nb\nc",
  startLine: 4,
  startCharacter: 0,
  endLine: 6,
  endCharacter: 1,
};

describe("selectionLoc", () => {
  it("renders a single-line selection as 1-based file:line:col", () => {
    expect(selectionLoc(single)).toBe("src/foo.ts:12:5");
  });

  it("renders a multi-line selection as 1-based file:start-end", () => {
    expect(selectionLoc(multi)).toBe("src/foo.ts:5-7");
  });
});

describe("selectionLineCount", () => {
  it("is inclusive and ≥ 1", () => {
    expect(selectionLineCount(single)).toBe(1);
    expect(selectionLineCount(multi)).toBe(3);
  });
});

describe("selectionToContribution", () => {
  it("builds the overlay's structured payload, verbatim text, role vscode", () => {
    expect(selectionToContribution(multi, "vscode://file/proj/src/foo.ts:5:1")).toEqual({
      kind: "selection",
      text: "a\nb\nc",
      sourceLoc: "src/foo.ts:5-7",
      url: "vscode://file/proj/src/foo.ts:5:1",
      role: "vscode",
      lines: 3,
    });
  });

  it("omits url when the caller has none", () => {
    expect(selectionToContribution(single)).not.toHaveProperty("url");
  });
});
