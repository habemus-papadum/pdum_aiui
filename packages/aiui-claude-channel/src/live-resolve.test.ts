import { describe, expect, it } from "vitest";
import {
  SELECTION_EXCERPT_CHARS,
  selectionInjectionLabel,
  selectionRetractionLabel,
} from "./live-resolve";

describe("selection injection labels (the [selection …] grammar)", () => {
  it("labels an app selection with its excerpt and authored-at locator", () => {
    expect(
      selectionInjectionLabel(
        "sel_2",
        { kind: "app", item: { text: "gradient stops", sourceLoc: "src/Legend.tsx:41:8" } },
        false,
      ),
    ).toBe(
      '[selection sel_2: "gradient stops" — on-screen selection authored at src/Legend.tsx:41:8]',
    );
  });

  it("labels an app selection without a locator", () => {
    expect(
      selectionInjectionLabel("sel_1", { kind: "app", item: { text: "the legend" } }, false),
    ).toBe('[selection sel_1: "the legend" — on-screen selection]');
  });

  it("marks a superseding re-emit under the same marker as updated", () => {
    expect(
      selectionInjectionLabel("sel_2", { kind: "app", item: { text: "gradient stops+" } }, true),
    ).toBe('[selection sel_2 updated: "gradient stops+" — on-screen selection]');
  });

  it("clips a long selection and says so (the full text reaches the prompt via the compiler)", () => {
    const long = "x".repeat(SELECTION_EXCERPT_CHARS * 3);
    const label = selectionInjectionLabel("sel_1", { kind: "app", item: { text: long } }, false);
    expect(label).toContain(" (clipped)");
    expect(label).toContain(`${"x".repeat(SELECTION_EXCERPT_CHARS)}…`);
    expect(label).not.toContain("x".repeat(SELECTION_EXCERPT_CHARS + 1));
  });

  it("labels a code selection with locator, line count, and a short excerpt", () => {
    expect(
      selectionInjectionLabel(
        "code_1",
        {
          kind: "code",
          item: { text: "const a = 1;\nconst b = 2;\nconst c = 3;", sourceLoc: "src/c.ts:12" },
        },
        false,
      ),
    ).toBe(
      "[selection code_1: src/c.ts:12 — 3 lines of code the human contributed: " +
        "`const a = 1;\nconst b = 2;\nconst c = 3;`]",
    );
  });

  it("counts a single line in the singular (and honors an explicit lines field)", () => {
    expect(
      selectionInjectionLabel("code_2", { kind: "code", item: { text: "let y = 0;" } }, false),
    ).toBe("[selection code_2: 1 line of code the human contributed: `let y = 0;`]");
  });

  it("labels a markerless selection (pre-marker clients) without an id", () => {
    expect(
      selectionInjectionLabel(undefined, { kind: "app", item: { text: "the legend" } }, false),
    ).toBe('[selection: "the legend" — on-screen selection]');
  });

  it("phrases a retraction as an explicit disregard", () => {
    expect(selectionRetractionLabel("sel_2")).toBe("[selection sel_2 retracted — disregard it]");
    expect(selectionRetractionLabel(undefined)).toBe("[selection retracted — disregard it]");
  });
});
