import type { LocatedComponent } from "@habemus-papadum/aiui-dev-overlay/intent-pipeline";
import { describe, expect, it } from "vitest";
import { type LabelEntry, renderShotBlock, resolveSegments } from "./live-resolve";

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
