import { describe, expect, it } from "vitest";
import { composeIntent, Engine } from "./engine";

function armedEngine(): Engine {
  let t = 0;
  const engine = new Engine({}, () => ++t);
  engine.setArmed(true);
  return engine;
}

describe("Engine thread lifecycle", () => {
  it("opens a thread implicitly on the first contentful act", () => {
    const engine = armedEngine();
    expect(engine.threadOpen).toBe(false);
    engine.talkStart();
    expect(engine.threadOpen).toBe(true);
    expect(engine.events.some((e) => e.type === "thread-open" && e.trigger === "talk")).toBe(true);
  });

  it("closes on send, and cancel-closes when disarmed mid-thread", () => {
    const engine = armedEngine();
    engine.strokeDone(10, { x: 0, y: 0, w: 5, h: 5 });
    engine.send();
    expect(engine.events.at(-1)).toMatchObject({ type: "thread-close", reason: "send" });

    engine.shotDone({ x: 0, y: 0, w: 10, h: 10 }, []);
    engine.setArmed(false);
    expect(
      engine.events.filter((e) => e.type === "thread-close" && e.reason === "cancel"),
    ).toHaveLength(1);
  });

  it("steps out one level at a time: correct → ink → cancel → disarm", () => {
    const engine = armedEngine();
    engine.talkStart();
    engine.talkEnd();
    engine.setMode("correct");
    engine.stepOut();
    expect(engine.mode).toBe("ink");
    expect(engine.threadOpen).toBe(true);
    engine.stepOut();
    expect(engine.threadOpen).toBe(false);
    expect(engine.armed).toBe(true);
    engine.stepOut();
    expect(engine.armed).toBe(false);
  });

  it("routes a spoken segment into the pending correction target", () => {
    const engine = armedEngine();
    const segment = engine.talkStart();
    engine.transcriptFinal(segment ?? 1, "make the curb thicker", 100, "mock");
    engine.setCorrectionTarget({ from: 9, to: 13, original: "curb" });
    const fix = engine.talkStart();
    engine.talkEnd();
    engine.transcriptFinal(fix ?? 2, "curve", 80, "mock");
    const correction = engine.events.find((e) => e.type === "correction");
    expect(correction).toMatchObject({ original: "curb", instruction: "curve", via: "speech" });
    expect(engine.correctionTarget).toBeUndefined();
  });
});

describe("composeIntent", () => {
  it("interleaves text and shots and applies replace-corrections", () => {
    const engine = armedEngine();
    const s1 = engine.talkStart();
    engine.talkEnd();
    engine.transcriptFinal(s1 ?? 1, "make the base line thicker", 90, "mock");
    engine.shotDone({ x: 1, y: 2, w: 30, h: 20 }, [
      { component: "Legend", source: "scenery.ts:33", rect: { x: 0, y: 0, w: 10, h: 10 } },
    ]);
    const s2 = engine.talkStart();
    engine.talkEnd();
    engine.transcriptFinal(s2 ?? 2, "and move the legend below", 90, "mock");
    engine.correction({ from: 9, to: 18, original: "base line" }, "baseline", "typed");

    const composed = composeIntent(engine.events, "replace");
    expect(composed.transcript).toBe("make the baseline thicker and move the legend below");
    expect(composed.items.map((i) => i.kind)).toEqual(["text", "shot", "text"]);
    expect(composed.corrections[0]).toMatchObject({ applied: true });
    expect(composed.components[0].component).toBe("Legend");
    // No saved file → the shot degrades to an inline bracket (Option A-ish).
    expect(composed.prompt).toContain("[shot_1 (components: Legend @ scenery.ts:33)]");
    expect(composed.meta).toEqual({});
  });

  it("emits Option C for shots with a saved path: body token + same-named meta", () => {
    const engine = armedEngine();
    const s1 = engine.talkStart();
    engine.talkEnd();
    engine.transcriptFinal(s1 ?? 1, "compare this", 90, "mock");
    engine.shotDone(
      { x: 1, y: 2, w: 30, h: 20 },
      [{ component: "Legend", source: "scenery.ts:33", rect: { x: 0, y: 0, w: 10, h: 10 } }],
      "data:image/png;base64,x",
      "/tmp/aiui-workbench/1-shot_1.png",
    );
    const s2 = engine.talkStart();
    engine.talkEnd();
    engine.transcriptFinal(s2 ?? 2, "against the mock", 90, "mock");

    const composed = composeIntent(engine.events);
    expect(composed.prompt).toContain("compare this {shot_1} against the mock");
    expect(composed.prompt).toContain("{shot_n} tokens are attached image paths");
    expect(composed.meta.shot_1).toBe("/tmp/aiui-workbench/1-shot_1.png");
    expect(composed.meta.shot_1_info).toBe("Legend @ scenery.ts:33");
  });

  it("excludes retracted shots (shot-drop) from items, prompt, and meta", () => {
    const engine = armedEngine();
    const s1 = engine.talkStart();
    engine.talkEnd();
    engine.transcriptFinal(s1 ?? 1, "compare this", 90, "mock");
    const first = engine.shotDone(
      { x: 1, y: 2, w: 30, h: 20 },
      [{ component: "Legend", source: "scenery.ts:33", rect: { x: 0, y: 0, w: 10, h: 10 } }],
      "data:image/png;base64,x",
      "/tmp/aiui-workbench/1-shot_1.png",
    );
    engine.shotDone(
      { x: 5, y: 6, w: 30, h: 20 },
      [],
      "data:image/png;base64,y",
      "/tmp/aiui-workbench/2-shot_2.png",
    );
    engine.dropShot(first);

    const composed = composeIntent(engine.events);
    // The retracted shot vanishes from the composition; the kept one stays.
    expect(composed.items.map((i) => i.kind)).toEqual(["text", "shot"]);
    expect(composed.items[1].marker).toBe("shot_2");
    expect(composed.prompt).not.toContain("shot_1");
    expect(composed.prompt).toContain("{shot_2}");
    expect(composed.meta).toEqual({ shot_2: "/tmp/aiui-workbench/2-shot_2.png" });
    // ...but the shot event itself is still in the stream (append-only; traces keep it).
    expect(engine.events.some((e) => e.type === "shot" && e.marker === "shot_1")).toBe(true);
  });

  it("applies a V4A patch correction across the whole transcript", () => {
    const engine = armedEngine();
    const s1 = engine.talkStart();
    engine.talkEnd();
    engine.transcriptFinal(s1 ?? 1, "make the curb thicker", 90, "mock");
    const s2 = engine.talkStart();
    engine.talkEnd();
    engine.transcriptFinal(s2 ?? 2, "and the curb should be amber", 90, "mock");

    // The pipeline's diff touches BOTH lines — beyond the selected span.
    engine.correction({ from: 9, to: 13, original: "curb" }, "curve", "speech", {
      patch: [
        "*** Begin Patch",
        "*** Update File: transcript",
        "@@",
        "-make the curb thicker",
        "+make the curve thicker",
        "@@",
        "-and the curb should be amber",
        "+and the curve should be amber",
        "*** End Patch",
      ].join("\n"),
      model: "mock",
      latencyMs: 3,
    });

    const composed = composeIntent(engine.events, "replace");
    expect(composed.transcript).toBe("make the curve thicker and the curve should be amber");
    expect(composed.corrections[0]).toMatchObject({ applied: true });
  });

  it("falls back to plain replacement when a patch doesn't apply", () => {
    const engine = armedEngine();
    const s1 = engine.talkStart();
    engine.talkEnd();
    engine.transcriptFinal(s1 ?? 1, "color the peek amber", 90, "mock");
    engine.correction({ from: 10, to: 14, original: "peek" }, "peak", "typed", {
      patch: "*** Begin Patch\n*** Update File: transcript\n@@\n-no such line\n+x\n*** End Patch",
      model: "mock",
      latencyMs: 2,
    });
    const composed = composeIntent(engine.events, "replace");
    expect(composed.transcript).toBe("color the peak amber");
  });

  it("keeps corrections as notes under the note policy", () => {
    const engine = armedEngine();
    const s1 = engine.talkStart();
    engine.talkEnd();
    engine.transcriptFinal(s1 ?? 1, "color the peek amber", 90, "mock");
    engine.correction({ from: 10, to: 14, original: "peek" }, "peak", "typed");

    const composed = composeIntent(engine.events, "note");
    expect(composed.transcript).toBe("color the peek amber");
    expect(composed.prompt).toContain('(transcription fix: "peek" → peak)');
  });

  it("scopes to the latest thread", () => {
    const engine = armedEngine();
    const s1 = engine.talkStart();
    engine.talkEnd();
    engine.transcriptFinal(s1 ?? 1, "old thread", 10, "mock");
    engine.send();
    const s2 = engine.talkStart();
    engine.talkEnd();
    engine.transcriptFinal(s2 ?? 2, "new thread", 10, "mock");

    expect(composeIntent(engine.events).transcript).toBe("new thread");
  });
});
