import type { LocatedComponent } from "@habemus-papadum/aiui-dev-overlay/intent-pipeline";
import { describe, expect, it } from "vitest";
import {
  type LabelEntry,
  renderShotBlock,
  resolveSegments,
  SELECTION_EXCERPT_CHARS,
  type SelectionEntry,
  selectionInjectionLabel,
  selectionRetractionLabel,
} from "./live-resolve";

const cwd = "/repo";

describe("resolveSegments", () => {
  it("joins text runs with spaces (matching composeIntent)", () => {
    const { body } = resolveSegments(
      [{ text: "make the panel" }, { text: "twice as wide" }],
      new Map(),
    );
    expect(body).toBe("make the panel twice as wide");
  });

  it("renders a registered image ref as the <screenshot> block at its position", () => {
    const registry = new Map<string, LabelEntry>([
      ["shot_1", { path: "/repo/.aiui-cache/shot_1.png", components: [] }],
    ]);
    const { body, resolvedMarkers, missingRefs } = resolveSegments(
      [{ text: "make" }, { image: "shot_1" }, { text: "wider" }],
      registry,
      { cwd },
    );
    expect(resolvedMarkers).toEqual(["shot_1"]);
    expect(missingRefs).toEqual([]);
    // Path relativized against cwd, wrapped in a self-closing tag (no components).
    expect(body).toContain('<screenshot path=".aiui-cache/shot_1.png"/>');
    expect(body.startsWith("make ")).toBe(true);
    expect(body.trimEnd().endsWith("wider")).toBe(true);
  });

  it("marks an unregistered ref visibly and reports it", () => {
    const { body, missingRefs } = resolveSegments(
      [{ text: "fix" }, { image: "shot_9" }],
      new Map(),
    );
    expect(body).toBe("fix [image shot_9 — not found]");
    expect(missingRefs).toEqual(["shot_9"]);
  });

  it("renders a shot with no saved path as a missing-image reference (not a crash)", () => {
    const registry = new Map<string, LabelEntry>([["shot_1", { components: [] }]]);
    const { missingRefs } = resolveSegments([{ image: "shot_1" }], registry, { cwd });
    expect(missingRefs).toEqual(["shot_1"]);
  });

  it("resolves selection ids to the FULL rendering, interleaved with text and shots", () => {
    const shots = new Map<string, LabelEntry>([
      ["shot_1", { path: "/repo/.aiui-cache/shot_1.png", components: [] }],
    ]);
    const selections = new Map<string, SelectionEntry>([
      [
        "sel_1",
        { kind: "app", item: { text: "gradient stops", sourceLoc: "src/Legend.tsx:41:8" } },
      ],
      ["code_1", { kind: "code", item: { text: "const a = 1;", sourceLoc: "src/c.ts:12" } }],
    ]);
    const { body, resolvedMarkers, missingRefs } = resolveSegments(
      [
        { text: "tint" },
        { selection: "sel_1" },
        { text: "to match" },
        { image: "shot_1" },
        { text: "as in" },
        { selection: "code_1" },
      ],
      shots,
      { cwd, selections },
    );
    expect(resolvedMarkers).toEqual(["sel_1", "shot_1", "code_1"]);
    expect(missingRefs).toEqual([]);
    // The same short/long renderings composeIntent inlines (engine.ts exports them).
    expect(body).toContain(
      'Regarding the on-screen selection "gradient stops" (authored at src/Legend.tsx:41:8)',
    );
    expect(body).toContain("Regarding `src/c.ts:12`: `const a = 1;`");
    expect(body).toContain('<screenshot path=".aiui-cache/shot_1.png"/>');
    expect(body.startsWith("tint ")).toBe(true);
  });

  it("a retracted selection resolves to NOTHING and is reported in missingRefs", () => {
    const selections = new Map<string, SelectionEntry>([
      ["sel_1", { kind: "app", item: { text: "gradient stops" }, retracted: true }],
    ]);
    const { body, resolvedMarkers, missingRefs } = resolveSegments(
      [{ text: "tint" }, { selection: "sel_1" }, { text: "please" }],
      new Map(),
      { selections },
    );
    expect(body).toBe("tint please");
    expect(body).not.toContain("gradient stops");
    expect(resolvedMarkers).toEqual([]);
    expect(missingRefs).toEqual(["sel_1"]);
  });

  it("an unknown selection id renders visibly and joins missingRefs", () => {
    const { body, missingRefs } = resolveSegments(
      [{ text: "fix" }, { selection: "sel_9" }],
      new Map(),
      { selections: new Map() },
    );
    expect(body).toBe("fix [selection sel_9 — not found]");
    expect(missingRefs).toEqual(["sel_9"]);
  });

  it("forgives a selection id carried in the image field (disjoint marker namespaces)", () => {
    const selections = new Map<string, SelectionEntry>([
      ["sel_1", { kind: "app", item: { text: "gradient stops" } }],
    ]);
    const { body, resolvedMarkers } = resolveSegments([{ image: "sel_1" }], new Map(), {
      selections,
    });
    expect(resolvedMarkers).toEqual(["sel_1"]);
    expect(body).toContain('Regarding the on-screen selection "gradient stops"');
  });
});

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

  it("clips a long selection and says so (the full text re-attaches at resolve)", () => {
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

describe("renderShotBlock (mirrors engine.ts renderShot)", () => {
  const component: LocatedComponent = {
    component: "Legend",
    source: "/repo/src/Legend.tsx:30:2",
    rect: { x: 0, y: 0, w: 10, h: 10 },
    cells: [{ name: "colorScale", source: "/repo/src/Legend.tsx:41:8" }],
  };

  it("emits an indented XML block with relativized element + cell sources", () => {
    const block = renderShotBlock(
      "shot_1",
      { path: "/repo/.aiui-cache/shot_1.png", components: [component] },
      { cwd, shotFormat: "xml" },
    );
    expect(block).toContain('<screenshot path=".aiui-cache/shot_1.png">');
    expect(block).toContain('<element name="Legend" source="src/Legend.tsx:30:2">');
    expect(block).toContain('<cell name="colorScale" source="src/Legend.tsx:41:8"/>');
    expect(block).toContain("</screenshot>");
  });

  it("renders a viewport shot as a single self-closing tag", () => {
    const block = renderShotBlock(
      "shot_2",
      { path: "/repo/.aiui-cache/shot_2.png", viewport: true },
      { cwd, shotFormat: "xml" },
    );
    expect(block).toBe('<screenshot path=".aiui-cache/shot_2.png" view="full-viewport"/>');
  });

  it("honors the text format", () => {
    const block = renderShotBlock(
      "shot_1",
      { path: "/repo/.aiui-cache/shot_1.png", components: [component] },
      { cwd, shotFormat: "text" },
    );
    expect(block).toContain("[screenshot: .aiui-cache/shot_1.png");
    expect(block).toContain("Legend @ src/Legend.tsx:30:2");
  });
});
