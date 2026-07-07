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

  it("contributes external text as prompt content, opening the thread when armed", () => {
    const engine = new Engine(
      {},
      ((): (() => number) => {
        let t = 0;
        return () => ++t;
      })(),
    );
    // Not armed → a contribution is a no-op (needs an armed turn to join).
    expect(engine.contribute("nope")).toBeUndefined();
    expect(engine.threadOpen).toBe(false);

    engine.setArmed(true);
    const segment = engine.contribute("Regarding `a.ts:1`: `x`");
    expect(typeof segment).toBe("number");
    expect(engine.threadOpen).toBe(true);
    expect(
      engine.events.some((e) => e.type === "thread-open" && e.trigger === "contribution"),
    ).toBe(true);
    // It composes into the prompt as content (a transcript-final, not a correction).
    const composed = composeIntent(engine.events, "replace");
    expect(composed.items.some((i) => i.kind === "text" && i.text?.includes("a.ts:1"))).toBe(true);
  });

  it("closes on send, and cancel-closes when disarmed mid-thread", () => {
    const engine = armedEngine();
    engine.strokeDone(10, { x: 0, y: 0, w: 5, h: 5 });
    engine.send();
    // Send closes the thread AND disarms (Enter ends the interaction).
    expect(engine.events.at(-2)).toMatchObject({ type: "thread-close", reason: "send" });
    expect(engine.events.at(-1)).toMatchObject({ type: "armed", on: false });
    expect(engine.armed).toBe(false);

    engine.setArmed(true); // a fresh turn needs a fresh arm
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

  it("videoShare opens a thread on the first ON and records both edges", () => {
    const engine = armedEngine();
    expect(engine.threadOpen).toBe(false);
    engine.videoShare(true);
    // Turning the share on is a contentful act — it opens the thread.
    expect(engine.threadOpen).toBe(true);
    expect(engine.events.some((e) => e.type === "thread-open" && e.trigger === "shot")).toBe(true);
    expect(engine.events.at(-1)).toMatchObject({ type: "video-share", on: true });
    engine.videoShare(false);
    expect(engine.events.at(-1)).toMatchObject({ type: "video-share", on: false });
    expect(engine.threadOpen).toBe(true); // off doesn't close the thread (send/cancel do)
  });

  it("flags a segment spoken at a correction target and keeps the target for commit", () => {
    const engine = armedEngine();
    const segment = engine.talkStart();
    engine.transcriptFinal(segment ?? 1, "make the curb thicker", 100, "mock");
    engine.setCorrectionTarget({ from: 9, to: 13, original: "curb" });
    const fix = engine.talkStart();
    engine.talkEnd();
    engine.transcriptFinal(fix ?? 2, "curve", 80, "mock");
    // Flagged as correction speech (not content), but NOT auto-submitted: the
    // words land in the correction bar, where typing and talking coexist and
    // Enter is the single commit gesture — so the target survives.
    const final = engine.events.filter((e) => e.type === "transcript-final").at(-1);
    expect(final).toMatchObject({ text: "curve", correction: true });
    expect(engine.events.some((e) => e.type === "correction")).toBe(false);
    expect(engine.correctionTarget).toEqual({ from: 9, to: 13, original: "curb" });
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
    // No saved file → the reference degrades but keeps the element info inline.
    expect(composed.prompt).toContain(
      '<screenshot marker="shot_1" missing="image not captured">\n' +
        '  <element name="Legend" source="scenery.ts:33"/>\n' +
        "</screenshot>",
    );
    expect(composed.meta).toEqual({});
  });

  it("inlines a saved shot at its position: path, elements, and cell frontier in the text", () => {
    const engine = armedEngine();
    const s1 = engine.talkStart();
    engine.talkEnd();
    engine.transcriptFinal(s1 ?? 1, "compare this", 90, "mock");
    engine.shotDone(
      { x: 1, y: 2, w: 30, h: 20 },
      [
        {
          component: "Legend",
          source: "scenery.ts:33",
          rect: { x: 0, y: 0, w: 10, h: 10 },
          cells: [{ name: "colorScale", source: "scenery.ts:41" }, { name: "ticks" }],
        },
      ],
      "data:image/png;base64,x",
      "/tmp/aiui-workbench/1-shot_1.png",
    );
    const s2 = engine.talkStart();
    engine.talkEnd();
    engine.transcriptFinal(s2 ?? 2, "against the mock", 90, "mock");

    const composed = composeIntent(engine.events);
    expect(composed.prompt).toContain(
      "compare this \n" +
        '<screenshot path="/tmp/aiui-workbench/1-shot_1.png">\n' +
        '  <element name="Legend" source="scenery.ts:33">\n' +
        '    <cell name="colorScale" source="scenery.ts:41"/>\n' +
        '    <cell name="ticks"/>\n' +
        "  </element>\n" +
        "</screenshot>\n " +
        "against the mock",
    );
    // Everything is in the text now: no meta block, no token↔meta hint line.
    expect(composed.meta).toEqual({});
    expect(composed.prompt).not.toContain("{shot_");
  });

  it("renders the plain-text style on request (shotFormat: text), sources relativized", () => {
    const engine = armedEngine();
    engine.shotDone(
      { x: 1, y: 2, w: 30, h: 20 },
      [
        {
          component: "Legend",
          source: "/repo/app/src/Legend.tsx:30:2",
          rect: { x: 0, y: 0, w: 10, h: 10 },
          cells: [{ name: "colorScale", source: "/repo/app/src/Legend.tsx:41:8" }],
        },
      ],
      "data:image/png;base64,x",
      "/repo/app/.aiui-cache/traces/t1/shot_1.png",
    );
    const composed = composeIntent(engine.events, "replace", {
      cwd: "/repo/app",
      shotFormat: "text",
    });
    expect(composed.prompt).toContain(
      "[screenshot: .aiui-cache/traces/t1/shot_1.png\n" +
        "  Legend @ src/Legend.tsx:30:2 — cells: colorScale @ src/Legend.tsx:41:8\n" +
        "]",
    );
  });

  it("relativizes shot paths under the compose cwd; a viewport shot carries no element info", () => {
    const engine = armedEngine();
    engine.shotDone(
      { x: 0, y: 0, w: 1024, h: 768 },
      [],
      "data:image/png;base64,x",
      "/repo/app/.aiui-cache/traces/t1/shot_1.png",
      true, // viewport
    );
    engine.shotDone(
      { x: 1, y: 2, w: 30, h: 20 },
      [{ component: "Legend", source: "scenery.ts:33", rect: { x: 0, y: 0, w: 10, h: 10 } }],
      "data:image/png;base64,y",
      "/somewhere/else/shot_2.png",
    );

    const composed = composeIntent(engine.events, "replace", { cwd: "/repo/app" });
    // Inside cwd → relative; the viewport shot is a single self-closing tag.
    expect(composed.prompt).toContain(
      '<screenshot path=".aiui-cache/traces/t1/shot_1.png" view="full-viewport"/>',
    );
    // Outside cwd → the absolute path is the truth; keep it.
    expect(composed.prompt).toContain(
      '<screenshot path="/somewhere/else/shot_2.png">\n' +
        '  <element name="Legend" source="scenery.ts:33"/>\n' +
        "</screenshot>",
    );
  });

  it("excludes retracted shots (shot-drop) from items and prompt", () => {
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
    expect(composed.prompt).toContain('<screenshot path="/tmp/aiui-workbench/2-shot_2.png"/>');
    expect(composed.meta).toEqual({});
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
    engine.setArmed(true); // send disarmed; re-arm for the next turn
    const s2 = engine.talkStart();
    engine.talkEnd();
    engine.transcriptFinal(s2 ?? 2, "new thread", 10, "mock");

    expect(composeIntent(engine.events).transcript).toBe("new thread");
  });
});
