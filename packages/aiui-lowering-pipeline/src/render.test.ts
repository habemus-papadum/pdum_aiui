import { describe, expect, it } from "vitest";
import { composeIntent, Engine } from "./engine";

function armedEngine(): Engine {
  let t = 0;
  const engine = new Engine({}, () => ++t);
  engine.setArmed(true);
  return engine;
}

/**
 * Every span must BRACKET the exact fragment it names in `prompt`: the hero
 * slices the raw prompt at these offsets, so `prompt.slice(start, end)` is the
 * contract. Text runs get no span (they are the default), so the span set is
 * exactly the non-text items.
 */
describe("renderPrompt spans", () => {
  it("a text-only prompt carries no spans", () => {
    const engine = armedEngine();
    const s = engine.talkStart();
    engine.transcriptFinal(s ?? 1, "make the baseline thicker", 90, "mock");
    const composed = composeIntent(engine.events, "replace");
    expect(composed.prompt).toBe("make the baseline thicker");
    expect(composed.spans).toEqual([]);
  });

  it("a shot between two text runs → a shot span slicing exactly the block", () => {
    const engine = armedEngine();
    const s1 = engine.talkStart();
    engine.transcriptFinal(s1 ?? 1, "before shot", 90, "mock");
    engine.shotDone(
      { x: 1, y: 2, w: 30, h: 20 },
      [
        {
          component: "Legend",
          source: "/repo/app/src/Legend.tsx:30:2",
          rect: { x: 0, y: 0, w: 10, h: 10 },
        },
      ],
      "data:image/png;base64,x",
      "/repo/app/.aiui-cache/traces/t1/shot_1.png",
    );
    const s2 = engine.talkStart();
    engine.transcriptFinal(s2 ?? 2, "after shot", 90, "mock");

    const composed = composeIntent(engine.events, "replace", { cwd: "/repo/app" });
    const shotSpans = composed.spans.filter((sp) => sp.kind === "shot");
    expect(shotSpans).toHaveLength(1);
    const span = shotSpans[0];

    const sliced = composed.prompt.slice(span.start, span.end);
    // The span brackets the screenshot block — and nothing of the prose.
    expect(sliced).toContain("<screenshot");
    expect(sliced).toContain(".aiui-cache/traces/t1/shot_1.png");
    expect(sliced).not.toContain("before shot");
    expect(sliced).not.toContain("after shot");
    // …and the prose sits strictly outside it.
    expect(composed.prompt.slice(0, span.start)).toContain("before shot");
    expect(composed.prompt.slice(span.end)).toContain("after shot");
    // Span metadata the hero renders from, no re-parsing needed. `path` carries
    // the raw (absolute) disk path — the hero's previewUrl fallback needs it,
    // and shotBlobName reduces it to the basename either way; the *text* is
    // relativized, but the span need not duplicate the text.
    if (span.kind === "shot") {
      expect(span.marker).toBe("shot_1");
      expect(span.path).toBe("/repo/app/.aiui-cache/traces/t1/shot_1.png");
      expect(span.components).toHaveLength(1);
    }
  });

  it("offsets stay correct across the final trim (a leading shot)", () => {
    const engine = armedEngine();
    // Shot first (multi-line block → a leading '\n' that the final .trim() drops).
    engine.shotDone(
      { x: 0, y: 0, w: 30, h: 20 },
      [{ component: "Plot", source: "src/Plot.tsx:3:1", rect: { x: 0, y: 0, w: 10, h: 10 } }],
      "data:image/png;base64,x",
      "/repo/app/.aiui-cache/traces/t1/shot_1.png",
    );
    const s = engine.talkStart();
    engine.transcriptFinal(s ?? 1, "tighten this", 90, "mock");

    const composed = composeIntent(engine.events, "replace", { cwd: "/repo/app" });
    const span = composed.spans.find((sp) => sp.kind === "shot");
    expect(span).toBeDefined();
    if (span) {
      // The leading newline was trimmed → the shot span starts at 0 and its
      // slice still opens the screenshot block.
      expect(span.start).toBe(0);
      expect(composed.prompt.slice(span.start, span.end)).toContain("<screenshot");
    }
    // The prompt itself never has leading/trailing whitespace.
    expect(composed.prompt).toBe(composed.prompt.trim());
  });

  it("code + app selections and a navigation each get a span slicing their render", () => {
    const engine = armedEngine();
    const s = engine.talkStart();
    engine.transcriptFinal(s ?? 1, "look here", 90, "mock");
    engine.codeSelection({ text: "const x = 1;", sourceLoc: "src/a.ts:5:1" });
    engine.appSelection({ text: "42.7", sourceLoc: "src/Doc.tsx:3:1" });
    engine.navigation("https://app.test/a", "https://app.test/b");

    const composed = composeIntent(engine.events, "replace");
    const kinds = composed.spans.map((sp) => sp.kind).sort();
    expect(kinds).toEqual(["app-selection", "code-selection", "navigation"]);

    for (const span of composed.spans) {
      const sliced = composed.prompt.slice(span.start, span.end);
      if (span.kind === "code-selection") {
        expect(sliced).toContain("const x = 1;");
      } else if (span.kind === "app-selection") {
        expect(sliced).toContain("42.7");
      } else if (span.kind === "navigation") {
        expect(sliced).toContain("page navigation");
      }
    }
    // composeIntent never emits a preamble span — that is the channel's to add.
    expect(composed.spans.some((sp) => sp.kind === "preamble")).toBe(false);
  });
});
