import { describe, expect, it, vi } from "vitest";
import { composeIntent, Engine } from "./engine";
import { renderAppSelection, renderCodeSelection } from "./render";

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

  it("steps out one level at a time: tweak → ink → cancel → disarm", () => {
    const engine = armedEngine();
    engine.talkStart();
    engine.talkEnd();
    engine.setMode("tweak");
    engine.stepOut();
    expect(engine.mode).toBe("ink");
    expect(engine.threadOpen).toBe(true);
    engine.stepOut();
    expect(engine.threadOpen).toBe(false);
    expect(engine.armed).toBe(true);
    engine.stepOut();
    expect(engine.armed).toBe(false);
  });

  it("a cancel mid-hold ends the talk too — talking never outlives its thread", () => {
    const engine = armedEngine();
    engine.talkStart();
    expect(engine.talking).toBe(true);
    engine.stepOut(); // Esc while still holding Space
    expect(engine.talking).toBe(false);
    expect(engine.threadOpen).toBe(false);
    // talk-end lands before the close, like send()/setArmed(false) mid-talk.
    expect(engine.events.at(-2)).toMatchObject({ type: "talk-end" });
    expect(engine.events.at(-1)).toMatchObject({ type: "thread-close", reason: "cancel" });
  });

  it("steps out of tweak back to ink with the thread still open (§B.5)", () => {
    const engine = armedEngine();
    engine.talkStart();
    engine.talkEnd();
    engine.setMode("tweak");
    expect(engine.events.at(-1)).toMatchObject({ type: "mode", mode: "tweak" });
    engine.stepOut();
    // Tweak steps back to composing, not straight to cancel — the excursion
    // must never cost the turn.
    expect(engine.mode).toBe("ink");
    expect(engine.threadOpen).toBe(true);
    expect(engine.events.some((e) => e.type === "thread-close")).toBe(false);
  });

  it("steps out of vscode mode back to ink with the thread still open", () => {
    const engine = armedEngine();
    engine.talkStart();
    engine.talkEnd();
    engine.setMode("vscode");
    expect(engine.events.at(-1)).toMatchObject({ type: "mode", mode: "vscode" });
    engine.stepOut();
    // Like tweak: the jump excursion steps back to composing, never to cancel.
    expect(engine.mode).toBe("ink");
    expect(engine.threadOpen).toBe(true);
    expect(engine.events.some((e) => e.type === "thread-close")).toBe(false);
  });

  it("suspends the idle auto-end timer during vscode mode, like tweak", () => {
    vi.useFakeTimers();
    try {
      const engine = new Engine({ autoEndSec: 1 });
      engine.setArmed(true);
      engine.talkStart();
      engine.talkEnd(); // idle now — the auto-end timer is armed
      engine.setMode("vscode");
      // The user jumped off to their editor — not "idle silence"; the open
      // turn must survive the whole excursion.
      vi.advanceTimersByTime(10_000);
      expect(engine.threadOpen).toBe(true);
      engine.setMode("ink");
      vi.advanceTimersByTime(1_001);
      expect(engine.threadOpen).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("suspends the idle auto-end timer during tweak and re-arms it on resume", () => {
    vi.useFakeTimers();
    try {
      const engine = new Engine({ autoEndSec: 1 });
      engine.setArmed(true);
      engine.talkStart();
      engine.talkEnd(); // idle now — the auto-end timer is armed
      engine.setMode("tweak");
      // Way past autoEndSec: the user is adjusting the app, not idling — the
      // thread must survive the whole excursion.
      vi.advanceTimersByTime(10_000);
      expect(engine.threadOpen).toBe(true);
      expect(engine.events.some((e) => e.type === "thread-close")).toBe(false);
      // Leaving tweak emits the mode event, which re-runs the scheduler.
      engine.setMode("ink");
      vi.advanceTimersByTime(1_001);
      expect(engine.threadOpen).toBe(false);
      expect(engine.events.at(-1)).toMatchObject({ type: "thread-close", reason: "timeout" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("videoShare opens a thread on the first ON and records both edges (with the share's terms)", () => {
    const engine = armedEngine();
    expect(engine.threadOpen).toBe(false);
    engine.videoShare(true, { ordinal: 1, mode: "smart", cadenceMs: 5000 });
    // Turning the share on is a contentful act — it opens the thread.
    expect(engine.threadOpen).toBe(true);
    expect(engine.events.some((e) => e.type === "thread-open" && e.trigger === "shot")).toBe(true);
    expect(engine.events.at(-1)).toMatchObject({
      type: "video-share",
      on: true,
      ordinal: 1,
      mode: "smart",
      cadenceMs: 5000,
    });
    engine.videoShare(false);
    expect(engine.events.at(-1)).toMatchObject({ type: "video-share", on: false });
    expect(engine.threadOpen).toBe(true); // off doesn't close the thread (send/cancel do)
  });
});

/**
 * Correct mode was removed in the append-only pivot, but `correction` /
 * `correction-undo` EVENTS remain in the vocabulary so historical traces
 * still compose — these fixtures push the raw events a legacy stream holds.
 */
function pushCorrection(
  engine: Engine,
  target: { from: number; to: number; original: string },
  instruction: string,
  diff?: { patch: string; model: string; latencyMs: number },
): void {
  engine.events.push({
    at: Date.now(),
    type: "correction",
    from: target.from,
    to: target.to,
    original: target.original,
    instruction,
    via: "typed",
    ...(diff !== undefined
      ? { patch: diff.patch, model: diff.model, latencyMs: diff.latencyMs }
      : {}),
  });
}

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
    pushCorrection(engine, { from: 9, to: 18, original: "base line" }, "baseline");

    const composed = composeIntent(engine.events, "replace");
    expect(composed.transcript).toBe("make the baseline thicker and move the legend below");
    expect(composed.items.map((i) => i.kind)).toEqual(["text", "shot", "text"]);
    expect(composed.corrections[0]).toMatchObject({ applied: true });
    expect(composed.components[0].component).toBe("Legend");
    // No saved file → the reference degrades but keeps the element info inline.
    expect(composed.prompt).toContain(
      "[screenshot shot_1 located at MISSING]\n" +
        '<screenshot-metadata marker="shot_1">\n' +
        '  <element name="Legend" source="scenery.ts:33"/>\n' +
        "</screenshot-metadata>",
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
      "/tmp/aiui-lab/1-shot_1.png",
    );
    const s2 = engine.talkStart();
    engine.talkEnd();
    engine.transcriptFinal(s2 ?? 2, "against the mock", 90, "mock");

    const composed = composeIntent(engine.events);
    expect(composed.prompt).toContain(
      "compare this\n\n" +
        "[screenshot located at /tmp/aiui-lab/1-shot_1.png]\n" +
        '<screenshot-metadata path="/tmp/aiui-lab/1-shot_1.png">\n' +
        '  <element name="Legend" source="scenery.ts:33">\n' +
        '    <cell name="colorScale" source="scenery.ts:41"/>\n' +
        '    <cell name="ticks"/>\n' +
        "  </element>\n" +
        "</screenshot-metadata>\n\n" +
        "against the mock",
    );
    // Everything is in the text now: no meta block, no token↔meta hint line.
    expect(composed.meta).toEqual({});
    expect(composed.prompt).not.toContain("{shot_");
  });

  it("caps a huge drag's element list behind elements-omitted", () => {
    const engine = armedEngine();
    // A drag framing the whole dashboard legitimately locates many panels;
    // the prompt keeps the first MAX_ELEMENTS_IN_PROMPT (document order) and
    // says how many it dropped, instead of shipping the full inventory.
    const many = Array.from({ length: 11 }, (_, i) => ({
      component: `Panel${i}`,
      source: `src/ui/Panel${i}.tsx:1:1`,
      rect: { x: 0, y: i * 10, w: 10, h: 10 },
    }));
    engine.shotDone({ x: 0, y: 0, w: 500, h: 500 }, many);

    const composed = composeIntent(engine.events);
    expect(composed.prompt).toContain('elements-omitted="3"');
    expect(composed.prompt).toContain('<element name="Panel7"');
    expect(composed.prompt).not.toContain('<element name="Panel8"');
    // The structured intent still carries everything — the cap is rendering.
    expect(composed.components).toHaveLength(11);
  });

  it("relativizes element and cell sources in the metadata block", () => {
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
    const composed = composeIntent(engine.events, "replace", { cwd: "/repo/app" });
    expect(composed.prompt).toContain(
      "[screenshot located at .aiui-cache/traces/t1/shot_1.png]\n" +
        '<screenshot-metadata path=".aiui-cache/traces/t1/shot_1.png">\n' +
        '  <element name="Legend" source="src/Legend.tsx:30:2">\n' +
        '    <cell name="colorScale" source="src/Legend.tsx:41:8"/>\n' +
        "  </element>\n" +
        "</screenshot-metadata>",
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
    // Inside cwd → relative; the viewport shot is a bare bracket line.
    expect(composed.prompt).toContain(
      "[screenshot located at .aiui-cache/traces/t1/shot_1.png (full viewport)]",
    );
    // Outside cwd → the absolute path is the truth; keep it.
    expect(composed.prompt).toContain(
      "[screenshot located at /somewhere/else/shot_2.png]\n" +
        '<screenshot-metadata path="/somewhere/else/shot_2.png">\n' +
        '  <element name="Legend" source="scenery.ts:33"/>\n' +
        "</screenshot-metadata>",
    );
  });

  it("annotates a share's sampled frames: capture mode, and the offset for continuous only", () => {
    const engine = armedEngine();
    // A smart-mode frame: it exists because the user touched the app — say so,
    // but its position in the prose already dates it, so no offset.
    engine.shotDone(
      { x: 0, y: 0, w: 1024, h: 768 },
      [],
      "data:image/jpeg;base64,x",
      "/repo/app/.aiui-cache/traces/t1/shot_1.jpg",
      true,
      1000,
      { ordinal: 1, mode: "smart", offsetMs: 0 },
    );
    // A machine-gun frame: the cadence took it, so the offset from the share's
    // first frame is the only thing that dates it.
    engine.shotDone(
      { x: 0, y: 0, w: 1024, h: 768 },
      [],
      "data:image/jpeg;base64,y",
      "/repo/app/.aiui-cache/traces/t1/shot_2.jpg",
      true,
      6000,
      { ordinal: 2, mode: "continuous", offsetMs: 5000 },
    );

    const composed = composeIntent(engine.events, "replace", { cwd: "/repo/app" });
    expect(composed.prompt).toContain(
      "[screenshot located at .aiui-cache/traces/t1/shot_1.jpg (captured on change; full viewport)]",
    );
    expect(composed.prompt).toContain(
      "[screenshot located at .aiui-cache/traces/t1/shot_2.jpg at +5.0s (full viewport)]",
    );
    // The items carry the terms through for the preview/debug viewers.
    expect(composed.items.map((i) => i.share?.mode)).toEqual(["smart", "continuous"]);
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
      "/tmp/aiui-lab/1-shot_1.png",
    );
    engine.shotDone(
      { x: 5, y: 6, w: 30, h: 20 },
      [],
      "data:image/png;base64,y",
      "/tmp/aiui-lab/2-shot_2.png",
    );
    engine.dropShot(first);

    const composed = composeIntent(engine.events);
    // The retracted shot vanishes from the composition; the kept one stays.
    expect(composed.items.map((i) => i.kind)).toEqual(["text", "shot"]);
    expect(composed.items[1].marker).toBe("shot_2");
    expect(composed.prompt).not.toContain("shot_1");
    expect(composed.prompt).toContain("[screenshot located at /tmp/aiui-lab/2-shot_2.png]");
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
    pushCorrection(engine, { from: 9, to: 13, original: "curb" }, "curve", {
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
    pushCorrection(engine, { from: 10, to: 14, original: "peek" }, "peak", {
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
    pushCorrection(engine, { from: 10, to: 14, original: "peek" }, "peak");

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

describe("app selection (a positional stream event, interleaved like text and shots)", () => {
  it("opens the turn with a marked app-selection event from the selection provider", () => {
    const engine = armedEngine();
    engine.selectionProvider = () => ({
      text: "reaction-diffusion on the GPU",
      sourceLoc: "src/App.tsx:35:13",
      cell: "catalog",
    });
    engine.talkStart();
    // Right after thread-open, before any transcript: the transcript BEGINS
    // with the selection — and the engine assigned its marker (house style).
    const types = engine.events.map((e) => e.type);
    expect(types.indexOf("app-selection")).toBe(types.indexOf("thread-open") + 1);
    expect(engine.events.find((e) => e.type === "app-selection")).toMatchObject({
      marker: "sel_1",
    });
    const composed = composeIntent(engine.events);
    expect(composed.items[0]).toMatchObject({
      kind: "app-selection",
      marker: "sel_1",
      text: "reaction-diffusion on the GPU",
      sourceLoc: "src/App.tsx:35:13",
      cell: "catalog",
    });
  });

  it("composes multiple interleaved selections at their stream positions", () => {
    const engine = armedEngine();
    const s1 = engine.talkStart();
    engine.talkEnd();
    engine.transcriptFinal(s1 ?? 1, "make this wider", 10, "mock");
    engine.appSelection({ text: "the histogram title", sourceLoc: "src/Hist.tsx:10:2" });
    const s2 = engine.talkStart();
    engine.talkEnd();
    engine.transcriptFinal(s2 ?? 2, "and match this", 10, "mock");
    engine.appSelection({ text: "the legend caption" });

    const composed = composeIntent(engine.events);
    expect(composed.items.map((i) => i.kind)).toEqual([
      "text",
      "app-selection",
      "text",
      "app-selection",
    ]);
    expect(composed.items[1]).toMatchObject({ marker: "sel_1", text: "the histogram title" });
    expect(composed.items[3]).toMatchObject({ marker: "sel_2", text: "the legend caption" });
  });

  it("renders selections INLINE in the prompt at their positions (short/long rule)", () => {
    const engine = armedEngine();
    const s1 = engine.talkStart();
    engine.talkEnd();
    engine.transcriptFinal(s1 ?? 1, "make this wider", 10, "mock");
    engine.appSelection({
      text: "the histogram title",
      sourceLoc: "src/Hist.tsx:10:2",
      cell: "hist",
      cellLoc: "src/model/cells.ts:7",
    });
    const composed = composeIntent(engine.events);
    expect(composed.prompt).toBe(
      "make this wider\n\n" +
        '[selected text: "the histogram title"]\n' +
        '<selection-metadata source="src/Hist.tsx:10:2">\n' +
        '  <cell name="hist" source="src/model/cells.ts:7"/>\n' +
        "</selection-metadata>",
    );
    // Selection text is never transcript text — corrections can't touch it.
    expect(composed.transcript).toBe("make this wider");
  });

  it("fences a long selection and carries the TeX attribution in metadata", () => {
    const engine = armedEngine();
    engine.talkStart();
    const long = "a very long run of selected page text ".repeat(10).trim();
    engine.appSelection({ text: long, sourceLoc: "src/Doc.tsx:3:1", tex: "\\frac{a}{b}" });
    const composed = composeIntent(engine.events);
    expect(composed.prompt).toContain(
      `[selected text (1 line)]:\n\`\`\`\n${long}\n\`\`\`\n` +
        '<selection-metadata source="src/Doc.tsx:3:1" tex="\\frac{a}{b}"/>',
    );
  });

  it("supersedes per marker: a refinement with nothing contentful between re-uses the marker", () => {
    const engine = armedEngine();
    engine.talkStart();
    engine.talkEnd();
    engine.appSelection({ text: "the histo" });
    engine.appSelection({ text: "the histogram title", cell: "hist" }); // the drag widened
    const selections = engine.events.filter((e) => e.type === "app-selection");
    expect(selections.map((e) => (e as { marker?: string }).marker)).toEqual(["sel_1", "sel_1"]);
    // One item, at the FIRST event's position, carrying the LATEST payload.
    const composed = composeIntent(engine.events);
    const items = composed.items.filter((i) => i.kind === "app-selection");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ marker: "sel_1", text: "the histogram title", cell: "hist" });
  });

  it("a contentful event in between mints a fresh marker (a NEW selection)", () => {
    const engine = armedEngine();
    const s1 = engine.talkStart();
    engine.talkEnd();
    engine.appSelection({ text: "first" });
    engine.transcriptFinal(s1 ?? 1, "spoken words", 10, "mock");
    engine.appSelection({ text: "second" });
    const selections = engine.events.filter((e) => e.type === "app-selection");
    expect(selections.map((e) => (e as { marker?: string }).marker)).toEqual(["sel_1", "sel_2"]);
    expect(
      composeIntent(engine.events)
        .items.filter((i) => i.kind === "app-selection")
        .map((i) => i.text),
    ).toEqual(["first", "second"]);
  });

  it("drops retract exactly one selection, by marker", () => {
    const engine = armedEngine();
    const s1 = engine.talkStart();
    engine.talkEnd();
    engine.appSelection({ text: "keep me not" });
    engine.transcriptFinal(s1 ?? 1, "between", 10, "mock");
    engine.appSelection({ text: "keep me" });

    expect(engine.appSelectionDrop("sel_1")).toBe(true);
    expect(engine.events.at(-1)).toMatchObject({ type: "app-selection-drop", marker: "sel_1" });
    const composed = composeIntent(engine.events);
    const items = composed.items.filter((i) => i.kind === "app-selection");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ marker: "sel_2", text: "keep me" });
    // Append-only: both selection events stay in the stream for the trace.
    expect(engine.events.filter((e) => e.type === "app-selection")).toHaveLength(2);
    // A markerless drop (the watcher clearing) retracts the latest carried one.
    expect(engine.appSelectionDrop()).toBe(true);
    expect(engine.events.at(-1)).toMatchObject({ type: "app-selection-drop", marker: "sel_2" });
    expect(composeIntent(engine.events).items.some((i) => i.kind === "app-selection")).toBe(false);
    // Nothing left to retract → no event.
    expect(engine.appSelectionDrop()).toBe(false);
  });

  it("a dropped marker is never re-used: the next selection is a new chip", () => {
    const engine = armedEngine();
    engine.talkStart();
    engine.talkEnd();
    engine.appSelection({ text: "first" });
    engine.appSelectionDrop();
    engine.appSelection({ text: "second" });
    const selections = engine.events.filter((e) => e.type === "app-selection");
    expect(selections.map((e) => (e as { marker?: string }).marker)).toEqual(["sel_1", "sel_2"]);
    const items = composeIntent(engine.events).items.filter((i) => i.kind === "app-selection");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ marker: "sel_2", text: "second" });
  });

  it("folds pre-marker streams latest-wins without crashing (old traces)", () => {
    // A stream captured before markers existed: markerless events, and the
    // retired whole-turn drop. No data is worth preserving; nothing may die.
    const legacy = composeIntent([
      { at: 1, type: "thread-open", trigger: "talk" },
      { at: 2, type: "app-selection", text: "first" },
      { at: 3, type: "app-selection", text: "second", cell: "flow" },
    ]);
    const items = legacy.items.filter((i) => i.kind === "app-selection");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ text: "second", cell: "flow" });

    const droppedAll = composeIntent([
      { at: 1, type: "thread-open", trigger: "talk" },
      { at: 2, type: "app-selection", text: "was here" },
      { at: 3, type: "app-selection-drop" },
    ]);
    expect(droppedAll.items.some((i) => i.kind === "app-selection")).toBe(false);
    expect(droppedAll.prompt).toBe("");
  });

  it("armed + no thread: an explicit selection OPENS the turn (panel pull model)", () => {
    // The 2026-07-11 contract change: "add selection" is a deliberate act, as
    // contentful as a contribution. Ambient watchers must still never open
    // turns — but that guard lives in the CALLER (the overlay modality
    // pre-filters on threadOpen), not here.
    const engine = armedEngine();
    expect(engine.appSelectionDrop()).toBe(false); // a retract still needs a thread
    expect(engine.appSelection({ text: "picked" })).toBe(true);
    expect(engine.threadOpen).toBe(true);
    expect(
      engine.events.some((e) => e.type === "thread-open" && e.trigger === "contribution"),
    ).toBe(true);
  });

  it("unarmed: a selection is a no-op and opens nothing", () => {
    let t = 0;
    const engine = new Engine({}, () => ++t);
    expect(engine.appSelection({ text: "stray" })).toBe(false);
    expect(engine.threadOpen).toBe(false);
    expect(engine.events.some((e) => e.type === "app-selection")).toBe(false);
  });
});

describe("navigation (a context boundary riding the turn, never opening one)", () => {
  const A = "http://app.test/";
  const B = "http://app.test/aztec";

  it("is a no-op without an open thread — navigation is context, not content", () => {
    const engine = armedEngine();
    expect(engine.navigation(A, B, "push")).toBe(false);
    expect(engine.threadOpen).toBe(false);
    expect(engine.events.some((e) => e.type === "navigation")).toBe(false);
  });

  it("records the boundary on an open thread, kind included", () => {
    const engine = armedEngine();
    engine.talkStart();
    expect(engine.navigation(A, B, "push")).toBe(true);
    const event = engine.events.find((e) => e.type === "navigation");
    expect(event).toMatchObject({ type: "navigation", from: A, to: B, kind: "push" });
  });

  it("carries a destination tab record through to the rendered <tab> element", () => {
    const engine = armedEngine();
    engine.talkStart();
    engine.navigation(A, B, "push", { url: B, title: "Aztec", aiui: true });
    const composed = composeIntent(engine.events);
    expect(composed.prompt).toContain(
      `[current page changed: <tab url="${B}" title="Aztec" aiui-app="true"/>]`,
    );
    // The span carries the record too — the trace hero's overlay data.
    expect(composed.spans.find((s) => s.kind === "navigation")).toMatchObject({
      tab: { url: B, title: "Aztec", aiui: true },
    });
  });

  it("composes positionally: content before the boundary reads as the old page's", () => {
    const engine = armedEngine();
    const seg = engine.talkStart() as number;
    engine.transcriptFinal(seg, "make this wider", 5, "test");
    engine.talkEnd();
    engine.navigation(A, B, "push");
    const seg2 = engine.talkStart() as number;
    engine.transcriptFinal(seg2, "and this taller", 5, "test");
    engine.talkEnd();

    const composed = composeIntent(engine.events, "replace");
    const kinds = composed.items.map((i) => i.kind);
    expect(kinds).toEqual(["text", "navigation", "text"]);
    // The lowered prompt carries the boundary between the two utterances,
    // rendered as short routes (origin is noise).
    const prompt = composed.prompt;
    const boundary = prompt.indexOf("[current page changed: /aztec]");
    expect(boundary).toBeGreaterThan(prompt.indexOf("make this wider"));
    expect(boundary).toBeLessThan(prompt.indexOf("and this taller"));
    // The transcript (text-only view) is unpolluted by the boundary.
    expect(composed.transcript).toBe("make this wider and this taller");
  });

  it("ink-clear carries the navigation reason", () => {
    const engine = armedEngine();
    engine.strokeDone(4, { x: 0, y: 0, w: 2, h: 2 });
    engine.inkCleared(true, "navigation");
    expect(engine.events.at(-1)).toMatchObject({
      type: "ink-clear",
      auto: true,
      reason: "navigation",
    });
  });
});

describe("tab-switch (the sibling boundary — a different tab, not the same tab navigating)", () => {
  const A = "http://app.test/";
  const B = "http://other.test/dashboard";

  it("is a no-op without an open thread — a switch is context, not content", () => {
    const engine = armedEngine();
    expect(engine.tabSwitch(A, B, 1, 2)).toBe(false);
    expect(engine.threadOpen).toBe(false);
    expect(engine.events.some((e) => e.type === "tab-switch")).toBe(false);
  });

  it("records the boundary on an open thread, tab identities included", () => {
    const engine = armedEngine();
    engine.talkStart();
    expect(engine.tabSwitch(A, B, 1, 2)).toBe(true);
    const event = engine.events.find((e) => e.type === "tab-switch");
    expect(event).toMatchObject({ type: "tab-switch", from: A, to: B, fromTab: 1, toTab: 2 });
  });

  it("is distinct from navigation — its own kind and its own rendering", () => {
    const engine = armedEngine();
    const seg = engine.talkStart() as number;
    engine.transcriptFinal(seg, "compare against this one", 5, "test");
    engine.talkEnd();
    engine.tabSwitch(A, B, 1, 2);
    const seg2 = engine.talkStart() as number;
    engine.transcriptFinal(seg2, "which is faster", 5, "test");
    engine.talkEnd();

    const composed = composeIntent(engine.events, "replace");
    expect(composed.items.map((i) => i.kind)).toEqual(["text", "tab-switch", "text"]);
    const prompt = composed.prompt;
    // Phrased as a tab switch, NOT a page navigation — and the driver's tab
    // handle still yields a minimal <tab> record when no full one rode along.
    const boundary = prompt.indexOf(
      '[current tab changed: <tab url="http://other.test/dashboard" driver-tab="2"/>]',
    );
    expect(boundary).toBeGreaterThan(prompt.indexOf("compare against this one"));
    expect(boundary).toBeLessThan(prompt.indexOf("which is faster"));
    expect(prompt).not.toContain("page navigation");
    expect(composed.transcript).toBe("compare against this one which is faster");
  });
});

describe("code selection (the reader's contribution, rendered at lowering time)", () => {
  it("opens the thread like a contribution and inlines a short selection", () => {
    const engine = armedEngine();
    expect(engine.codeSelection({ text: "const x = 1;", sourceLoc: "src/a.ts:5:1" })).toBe(
      "code_1",
    );
    expect(engine.threadOpen).toBe(true);
    expect(
      engine.events.some((e) => e.type === "thread-open" && e.trigger === "contribution"),
    ).toBe(true);
    const composed = composeIntent(engine.events);
    expect(composed.items.map((i) => i.kind)).toEqual(["code-selection"]);
    expect(composed.items[0]).toMatchObject({ marker: "code_1" });
    expect(composed.prompt).toBe("[code selection at `src/a.ts:5:1`: `const x = 1;`]");
    // Structured code is NOT transcript text — corrections can't touch it.
    expect(composed.transcript).toBe("");
  });

  it("code-selection-drop retracts exactly one chip, like deleting a screenshot", () => {
    const engine = armedEngine();
    const first = engine.codeSelection({ text: "const a = 1;", sourceLoc: "src/a.ts:1:1" });
    engine.codeSelection({ text: "const b = 2;", sourceLoc: "src/b.ts:2:2" });
    expect(first).toBe("code_1");
    engine.dropCodeSelection(first ?? "");

    const composed = composeIntent(engine.events);
    // The retracted selection vanishes from the composition; the kept one stays.
    expect(composed.items.map((i) => i.kind)).toEqual(["code-selection"]);
    expect(composed.items[0]).toMatchObject({ marker: "code_2" });
    expect(composed.prompt).toBe("[code selection at `src/b.ts:2:2`: `const b = 2;`]");
    // ...but the event itself stays in the stream (append-only; traces keep it).
    expect(engine.events.some((e) => e.type === "code-selection" && e.marker === "code_1")).toBe(
      true,
    );
    expect(engine.events.at(-1)).toMatchObject({ type: "code-selection-drop", marker: "code_1" });
  });

  it("fences a long selection under its location header", () => {
    const engine = armedEngine();
    const code = Array.from({ length: 12 }, (_, i) => `line ${i} of something long enough`).join(
      "\n",
    );
    engine.codeSelection({ text: code, sourceLoc: "src/b.ts:10-21", lines: 12 });
    const composed = composeIntent(engine.events);
    expect(composed.prompt).toContain("[code selection at `src/b.ts:10-21` (12 lines)]:\n```\n");
    expect(composed.prompt).toContain(`${code}\n\`\`\``);
  });

  it("keeps code selections out of the correction line space", () => {
    const engine = armedEngine();
    const s1 = engine.talkStart();
    engine.talkEnd();
    engine.transcriptFinal(s1 ?? 1, "rename the curb helper", 10, "mock");
    engine.codeSelection({ text: "function curb() {}", sourceLoc: "src/c.ts:1:1" });
    const s2 = engine.talkStart();
    engine.talkEnd();
    engine.transcriptFinal(s2 ?? 2, "and export it", 10, "mock");
    // The plain replacement rewrites the first TEXT occurrence — the code
    // item, though it also contains "curb", is not a candidate.
    pushCorrection(engine, { from: 11, to: 15, original: "curb" }, "curve");

    const composed = composeIntent(engine.events, "replace");
    expect(composed.transcript).toBe("rename the curve helper and export it");
    expect(composed.prompt).toContain("`function curb() {}`");
  });

  it("is a no-op when not armed (a contribution needs an armed turn to join)", () => {
    let t = 0;
    const engine = new Engine({}, () => ++t);
    expect(engine.codeSelection({ text: "x" })).toBeUndefined();
    expect(engine.events).toHaveLength(0);
  });
});

describe("selection render helpers (exported — the channel's live resolver re-uses them)", () => {
  // The realtime submode resolves a bare selection id from `submit_intent`
  // back to the SAME rendering composeIntent inlines — one implementation, so
  // these pin that the exported helpers ARE that rendering.

  it("renderAppSelection: short → bracket line with the attribution in metadata", () => {
    expect(
      renderAppSelection({
        text: "the histogram title",
        sourceLoc: "src/Hist.tsx:10:2",
        cell: "hist",
      }),
    ).toBe(
      '[selected text: "the histogram title"]\n' +
        '<selection-metadata source="src/Hist.tsx:10:2">\n' +
        '  <cell name="hist"/>\n' +
        "</selection-metadata>",
    );
  });

  it("renderAppSelection: long → fenced block (matches the compose inline form)", () => {
    const long = "a very long run of selected page text ".repeat(10).trim();
    const engine = armedEngine();
    engine.talkStart();
    engine.appSelection({ text: long, sourceLoc: "src/Doc.tsx:3:1" });
    const composed = composeIntent(engine.events);
    expect(composed.prompt.trim()).toBe(
      renderAppSelection({ text: long, sourceLoc: "src/Doc.tsx:3:1" }).trim(),
    );
  });

  it("renderCodeSelection: short → inline bracket; long → fenced under its locator", () => {
    expect(renderCodeSelection({ text: "const x = 1;", sourceLoc: "src/a.ts:5:1" })).toBe(
      "[code selection at `src/a.ts:5:1`: `const x = 1;`]",
    );
    const code = Array.from({ length: 12 }, (_, i) => `line ${i} of something long enough`).join(
      "\n",
    );
    const block = renderCodeSelection({ text: code, sourceLoc: "src/b.ts:10-21", lines: 12 });
    expect(block).toContain("[code selection at `src/b.ts:10-21` (12 lines)]:\n```\n");
    expect(block).toContain(`${code}\n\`\`\``);
  });

  it("elides a fenced selection past 50 lines, saying how many were cut", () => {
    const code = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join("\n");
    const block = renderCodeSelection({ text: code, sourceLoc: "src/big.ts:1-60", lines: 60 });
    expect(block).toContain("(60 lines)]:");
    expect(block).toContain("line 50\n… (+10 more lines elided)\n```");
    expect(block).not.toContain("line 51");
  });

  it("renders the page's <tab> record (full URL) in selection metadata", () => {
    expect(renderAppSelection({ text: "42.7", url: "http://localhost:5173/sim?run=3" })).toBe(
      '[selected text: "42.7"]\n' +
        "<selection-metadata>\n" +
        '  <tab url="http://localhost:5173/sim?run=3"/>\n' +
        "</selection-metadata>",
    );
    expect(
      renderCodeSelection({ text: "const x = 1;", url: "http://localhost:5173/reader" }),
    ).toContain('<tab url="http://localhost:5173/reader"/>');
  });
});

describe("the timestamp interleave (takenAt anchoring)", () => {
  /**
   * Streams are built from RAW events with realistic wall-clock stamps —
   * the lag compensation reasons in milliseconds (the wire contract for
   * `at`), which the engine verbs' synthetic tick clock can't express.
   *
   * The fixture: talk-start at t=1000; the user speaks immediately, and the
   * transcriber's deltas arrive ~800 ms behind the speech they transcribe
   * (first delta at 1800 → measured lag 800).
   */
  const T0 = 1000;
  const LAG = 800;
  function longWindowStream(
    finalText: string,
    cumulative: Array<[number, string]>,
    endAt: number = T0 + 5000,
  ): IntentEvent[] {
    return [
      { at: T0 - 10, type: "armed", on: true },
      { at: T0 - 5, type: "thread-open", trigger: "talk" },
      { at: T0, type: "talk-start", segment: 1 },
      ...cumulative.map(
        ([at, text]): IntentEvent => ({ at, type: "transcript-delta", segment: 1, text }),
      ),
      { at: endAt, type: "talk-end", segment: 1, ms: endAt - T0 },
      {
        at: endAt + 600,
        type: "transcript-final",
        segment: 1,
        text: finalText,
        latencyMs: 600,
        model: "rt",
      },
    ];
  }
  const shotAt = (takenAt: number, at: number): IntentEvent => ({
    at,
    type: "shot",
    marker: "shot_1",
    rect: { x: 0, y: 0, w: 10, h: 10 },
    components: [],
    takenAt,
  });

  it("compensates for delta lag: the split reflects the words SPOKEN by the gesture", () => {
    // Cumulative deltas, each arriving LAG after the words were spoken:
    //   spoken by 1500: "make the legend"            → delta at 2300
    //   spoken by 2600: "…wider and"                 → delta at 3400
    //   spoken by 4000: "…move it below"             → delta at 4800
    // Release at T0+4000; the last delta straggles in one LAG later, so the
    // estimator's clean TAIL anchor measures exactly 800 ms.
    const events = longWindowStream(
      "make the legend wider and move it below",
      [
        [T0 + 1500 + LAG, "make the legend"],
        [T0 + 2600 + LAG, "make the legend wider and"],
        [T0 + 4000 + LAG, "make the legend wider and move it below"],
      ],
      T0 + 4000,
    );
    // The shot gesture lands at t=3600 — the user had just said "…wider and"
    // (arrival-time math alone would put the split one delta EARLY, after
    // just "make the legend": at 3600 only the first delta had arrived).
    events.splice(6, 0, shotAt(T0 + 2600 + 50, T0 + 2600 + 120));
    const composed = composeIntent(events);
    expect(composed.items.map((i) => i.kind)).toEqual(["text", "shot", "text"]);
    expect(composed.items[0].text).toBe("make the legend wider and");
    expect(composed.items[2].text).toBe("move it below");
    expect(composed.transcript).toBe("make the legend wider and move it below");
  });

  it("nudges a mid-word offset to the word's end — a shot never splits a word", () => {
    const events = longWindowStream("tighten the baseline now please", [
      [T0 + 500 + LAG, "tighten the base"], // 16 chars — mid-"baseline"
      [T0 + 2000 + LAG, "tighten the baseline now please"],
    ]);
    events.splice(5, 0, shotAt(T0 + 500 + 10, T0 + 600));
    const composed = composeIntent(events);
    expect(composed.items[0].text).toBe("tighten the baseline");
    expect(composed.items[1].kind).toBe("shot");
    expect(composed.items[2].text).toBe("now please");
  });

  it("snaps forward past a sentence end just ahead — shots cluster at sentence seams", () => {
    const events = longWindowStream("make it wider. also fix the legend", [
      [T0 + 700 + LAG, "make it wi"], // mid-"wider", sentence end 4 chars past the word
      [T0 + 2500 + LAG, "make it wider. also fix the legend"],
    ]);
    events.splice(5, 0, shotAt(T0 + 700, T0 + 800));
    const composed = composeIntent(events);
    // Word-end alone would split after "wider." mid-clause boundary…
    // the snap carries it past the period, never further.
    expect(composed.items[0].text).toBe("make it wider.");
    expect(composed.items[1].kind).toBe("shot");
    expect(composed.items[2].text).toBe("also fix the legend");
  });

  it("does not hop a shot already at a sentence seam over the NEXT sentence", () => {
    // The lookahead finishes the sentence the gesture landed inside. When the
    // offset already sits just past a period, there is nothing to finish — and
    // snapping would carry the shot past a whole further sentence (which the
    // short sentences of live speech make easy to hit).
    const events = longWindowStream(
      "okay this is a demo. then I can talk again.",
      [
        [T0 + 1000 + LAG, "okay this is a demo."],
        [T0 + 2000 + LAG, "okay this is a demo. then I can talk again."],
      ],
      T0 + 2000, // release; the last delta straggles in one LAG later
    );
    events.splice(5, 0, shotAt(T0 + 1000 + 20, T0 + 1000 + 90));
    const composed = composeIntent(events);
    expect(composed.items.map((i) => i.kind)).toEqual(["text", "shot", "text"]);
    expect(composed.items[0].text).toBe("okay this is a demo.");
    expect(composed.items[2].text).toBe("then I can talk again.");
  });

  it("anchors a shot taken JUST AFTER release to the end of that segment's text", () => {
    // The today-bug this fixes: the shot event reaches the stream before the
    // final does, so arrival order used to compose the image BEFORE the
    // words it followed.
    const events = longWindowStream("look at the resulting pattern", [
      [T0 + 900 + LAG, "look at the resulting pattern"],
    ]);
    // Taken 400 ms after talk-end (the final lands 600 ms after) — the shot
    // event arrives BEFORE the final in stream order.
    events.splice(5, 0, shotAt(T0 + 5400, T0 + 5450));
    const composed = composeIntent(events);
    expect(composed.items.map((i) => i.kind)).toEqual(["text", "shot"]);
    expect(composed.items[0].text).toBe("look at the resulting pattern");
  });

  it("keeps arrival order for legacy shots (no takenAt) and long-idle shots", () => {
    // Legacy: no takenAt — byte-identical to the old fold.
    const legacy = longWindowStream("make this wider", [[T0 + 500 + LAG, "make this wider"]]);
    legacy.splice(3, 0, {
      at: T0 + 100,
      type: "shot",
      marker: "shot_1",
      rect: { x: 0, y: 0, w: 10, h: 10 },
      components: [],
    });
    expect(composeIntent(legacy).items.map((i) => i.kind)).toEqual(["shot", "text"]);

    // Idle: takenAt far outside any window (past the post-release grace) —
    // arrival order too.
    const idle = longWindowStream("look at this", [[T0 + 500 + LAG, "look at this"]]);
    idle.push(shotAt(T0 + 60_000, T0 + 60_050));
    expect(composeIntent(idle).items.map((i) => i.kind)).toEqual(["text", "shot"]);
  });

  it("a shot taken before any words in the window stays ahead of the text", () => {
    // A short utterance: release at T0+1400, its one delta straggling in a
    // LAG later (the tail anchor again measures 800 ms).
    const events = longWindowStream(
      "the words came later",
      [[T0 + 1400 + LAG, "the words came later"]],
      T0 + 1400,
    );
    // Taken right at window open — even lag-shifted, no delta precedes it.
    events.splice(3, 0, shotAt(T0 + 5, T0 + 60));
    const composed = composeIntent(events);
    expect(composed.items.map((i) => i.kind)).toEqual(["shot", "text"]);
    expect(composed.items[1].text).toBe("the words came later");
  });
});

describe("segment-replace (the panel's segment editor)", () => {
  /** A spoken segment with word timestamps and a shot anchored mid-text. */
  const T0 = 1000;
  function editedStream(): IntentEvent[] {
    return [
      { at: T0 - 10, type: "armed", on: true },
      { at: T0 - 5, type: "thread-open", trigger: "talk" },
      { at: T0 - 2, type: "navigation", from: "https://a.test/x", to: "https://a.test/y" },
      { at: T0, type: "talk-start", segment: 1 },
      { at: T0 + 900, type: "transcript-delta", segment: 1, text: "make the legend" },
      { at: T0 + 2400, type: "transcript-delta", segment: 1, text: "make the legend wider now" },
      // The shot gesture at t=+1400 — between "legend" (ends 1200) and
      // "wider" (starts 1600) by WORD TIMESTAMPS below.
      {
        at: T0 + 1450,
        type: "shot",
        marker: "shot_1",
        rect: { x: 0, y: 0, w: 10, h: 10 },
        components: [],
        takenAt: T0 + 1400,
      },
      { at: T0 + 3000, type: "talk-end", segment: 1, ms: 3000 },
      {
        at: T0 + 3600,
        type: "transcript-final",
        segment: 1,
        text: "make the legend wider now",
        latencyMs: 600,
        model: "rt",
        words: [
          { text: "make", startMs: 0, endMs: 400 },
          { text: "the", startMs: 400, endMs: 700 },
          { text: "legend", startMs: 700, endMs: 1200 },
          { text: "wider", startMs: 1600, endMs: 2000 },
          { text: "now", startMs: 2000, endMs: 2400 },
        ],
      },
    ];
  }

  it("replaces the segment's text IN PLACE and reflows the shot on the new words", () => {
    const events = editedStream();
    const before = composeIntent(events);
    expect(before.items.map((i) => i.kind)).toEqual(["navigation", "text", "shot", "text"]);
    expect(before.items[1].text).toBe("make the legend");

    // The editor fixed "legend" → "caption" and re-timestamped (kept words
    // keep their times; the fix inherits its slot).
    events.push({
      at: T0 + 9000,
      type: "segment-replace",
      segment: 1,
      text: "make the caption wider now",
      words: [
        { text: "make", startMs: 0, endMs: 400 },
        { text: "the", startMs: 400, endMs: 700 },
        { text: "caption", startMs: 700, endMs: 1200 },
        { text: "wider", startMs: 1600, endMs: 2000 },
        { text: "now", startMs: 2000, endMs: 2400 },
      ],
    });
    const after = composeIntent(events);
    // Same shape, same POSITION (after the navigation, where the final sat);
    // new text on both sides of the reflowed shot.
    expect(after.items.map((i) => i.kind)).toEqual(["navigation", "text", "shot", "text"]);
    expect(after.items[1].text).toBe("make the caption");
    expect(after.items[3].text).toBe("wider now");
    expect(after.transcript).toBe("make the caption wider now");
  });

  it("latest replacement wins, and the trace keeps every prior text", () => {
    const events = editedStream();
    events.push(
      { at: T0 + 9000, type: "segment-replace", segment: 1, text: "first fix" },
      { at: T0 + 9500, type: "segment-replace", segment: 1, text: "second fix" },
    );
    const composed = composeIntent(events);
    const texts = composed.items.filter((i) => i.kind === "text").map((i) => i.text);
    expect(texts).toEqual(["second fix"]); // one row, latest text
    // The events themselves stay in the stream — the trace still shows all.
    expect(events.filter((e) => e.type === "segment-replace")).toHaveLength(2);
  });

  it("a replacement without words degrades to the ORIGINAL anchors (best effort)", () => {
    const events = editedStream();
    events.push({
      at: T0 + 9000,
      type: "segment-replace",
      segment: 1,
      text: "make the caption wider now",
    });
    const composed = composeIntent(events);
    // The original words align by TEXT against the edited text (wordOffsetAt's
    // moving cursor, diverged words skipped): "legend" no longer matches, so
    // the shot anchors after the last kept word spoken before the gesture —
    // "make the". Approximate on purpose; the editor sends retimed words in
    // practice, and this is the shape of the fallback when it cannot.
    expect(composed.items.map((i) => i.kind)).toEqual(["navigation", "text", "shot", "text"]);
    expect(composed.items[1].text).toBe("make the");
    expect(composed.transcript).toBe("make the caption wider now");
  });

  it("suppresses the provisional run for a replaced segment (streaming compose)", () => {
    const events: IntentEvent[] = [
      { at: 0, type: "armed", on: true },
      { at: 1, type: "thread-open", trigger: "talk" },
      { at: 2, type: "talk-start", segment: 1 },
      { at: 3, type: "transcript-delta", segment: 1, text: "still streaming words" },
      { at: 4, type: "segment-replace", segment: 1, text: "edited before the final" },
    ];
    const composed = composeIntent(events, "replace", { streaming: true });
    const texts = composed.items.filter((i) => i.kind === "text");
    // No final in scope: the replacement places at its own stream position,
    // and the provisional run is gone (an edited segment is not in flight).
    expect(texts).toHaveLength(1);
    expect(texts[0].text).toBe("edited before the final");
    expect(texts[0].provisional).toBeUndefined();
  });

  it("works with drops: delete the shot AND fix the text in one edit", () => {
    const events = editedStream();
    events.push(
      { at: T0 + 9000, type: "shot-drop", marker: "shot_1" },
      { at: T0 + 9001, type: "segment-replace", segment: 1, text: "make the caption wider now" },
    );
    const composed = composeIntent(events);
    expect(composed.items.map((i) => i.kind)).toEqual(["navigation", "text"]);
    expect(composed.items[1].text).toBe("make the caption wider now");
  });
});

describe("pasted images (clipboard pixels, labeled honestly)", () => {
  it("renders '[pasted image located at …]' — never 'screenshot'", () => {
    const events: IntentEvent[] = [
      { at: 0, type: "armed", on: true },
      { at: 1, type: "thread-open", trigger: "explicit" },
      {
        at: 2,
        type: "shot",
        marker: "shot_1",
        rect: { x: 0, y: 0, w: 10, h: 10 },
        components: [],
        path: "/tmp/paste.png",
        origin: "paste",
      },
    ];
    const composed = composeIntent(events, "replace");
    expect(composed.prompt).toContain("[pasted image located at /tmp/paste.png]");
    expect(composed.prompt).not.toContain("screenshot");
    expect(composed.items[0].origin).toBe("paste");
  });

  it("the engine verb stamps provenance; a capture stays unmarked", () => {
    const engine = new Engine();
    engine.setArmed(true);
    engine.shotDone({ x: 0, y: 0, w: 4, h: 4 }, [], undefined, "/tmp/a.png");
    engine.shotDone(
      { x: 0, y: 0, w: 4, h: 4 },
      [],
      undefined,
      "/tmp/b.png",
      false,
      undefined,
      undefined,
      "paste",
    );
    const shots = engine.events.filter((e) => e.type === "shot");
    expect(shots[0].origin).toBeUndefined();
    expect(shots[1].origin).toBe("paste");
  });
});

describe("streaming compose (the live transcript preview)", () => {
  const T0 = 1000;
  const LAG = 800;
  const STREAMING = { streaming: true } as const;

  /**
   * A hands-free turn caught mid-utterance: deltas so far, no talk-end, no
   * final. Wall-clock, because the interleave reasons in milliseconds.
   *
   * The speech: "okay this is a demo." lands at T0+1000, "then I can talk
   * again." at T0+2000, "and once more." at T0+3000. Each delta arrives one
   * LAG behind the words it carries — and the transcriber emits its first
   * delta ("okay") one LAG after talk-start, so the lag estimator's HEAD
   * anchor (`first delta − window start`, all it has while the window is still
   * open) measures the true 800 ms rather than the speech-onset delay.
   */
  const DELTAS: Array<[number, string]> = [
    [T0 + LAG, "okay"],
    [T0 + 1000 + LAG, "okay this is a demo."],
    [T0 + 2000 + LAG, "okay this is a demo. then I can talk again."],
    [T0 + 3000 + LAG, "okay this is a demo. then I can talk again. and once more."],
  ];
  function liveStream(
    cumulative: Array<[number, string]>,
    shots: IntentEvent[] = [],
  ): IntentEvent[] {
    return [
      { at: T0 - 10, type: "armed", on: true },
      { at: T0 - 5, type: "thread-open", trigger: "talk" },
      { at: T0, type: "talk-start", segment: 1 },
      ...cumulative.map(
        ([at, text]): IntentEvent => ({ at, type: "transcript-delta", segment: 1, text }),
      ),
      ...shots,
    ].sort((a, b) => a.at - b.at);
  }
  /** A shot whose gesture lands at `takenAt`; the event reaches the stream 70 ms later. */
  const shot = (marker: string, takenAt: number): IntentEvent => ({
    at: takenAt + 70,
    type: "shot",
    marker,
    rect: { x: 0, y: 0, w: 10, h: 10 },
    components: [],
    takenAt,
  });

  it("composes nothing from in-flight words unless asked — the send path is unchanged", () => {
    const events = liveStream(DELTAS);
    expect(composeIntent(events).items).toEqual([]);
    expect(composeIntent(events).prompt).toBe("");
  });

  it("composes the still-spoken words as ONE provisional run", () => {
    const items = composeIntent(liveStream(DELTAS), "replace", STREAMING).items;
    expect(items).toEqual([
      {
        kind: "text",
        text: "okay this is a demo. then I can talk again. and once more.",
        segment: 1,
        provisional: true,
      },
    ]);
  });

  it("drops a live screenshot where it was taken, not ahead of the whole segment", () => {
    // The hands-free bug: a shot arrives while its segment has no final, so
    // the fold had no text run to split and the shots stacked at the front —
    // until the final landed and reordered everything at once.
    const events = liveStream(DELTAS, [
      shot("shot_1", T0 + 1000 + 20), // just after "…a demo."
      shot("shot_2", T0 + 2000 + 20), // just after "…talk again."
    ]);
    const items = composeIntent(events, "replace", STREAMING).items;
    expect(items.map((i) => i.kind)).toEqual(["text", "shot", "text", "shot", "text"]);
    expect(items[0].text).toBe("okay this is a demo.");
    expect(items[1].marker).toBe("shot_1");
    expect(items[2].text).toBe("then I can talk again.");
    expect(items[3].marker).toBe("shot_2");
    expect(items[4].text).toBe("and once more.");
    // Every run of an unfinalized segment stays provisional, split or not.
    expect(items.filter((i) => i.kind === "text").every((i) => i.provisional)).toBe(true);
  });

  it("holds a placed shot still as the words keep streaming in behind it", () => {
    // The offset is read at `takenAt + lag`. Once deltas arrive from past that
    // instant, the answer stops changing: they extend the tail rather than
    // push the shot rightward.
    const shots = [shot("shot_1", T0 + 1000 + 20)];
    const upTo = (n: number) =>
      composeIntent(liveStream(DELTAS.slice(0, n), shots), "replace", STREAMING).items;

    // The delta carrying "…a demo." has arrived; the shot pins to its end.
    expect(upTo(2).map((i) => i.kind)).toEqual(["text", "shot"]);
    expect(upTo(2)[0].text).toBe("okay this is a demo.");

    // Two more deltas of new speech — the split offset is unmoved.
    expect(upTo(3).map((i) => i.kind)).toEqual(["text", "shot", "text"]);
    expect(upTo(3)[0].text).toBe("okay this is a demo.");
    expect(upTo(3)[2].text).toBe("then I can talk again.");

    expect(upTo(4)[0].text).toBe("okay this is a demo.");
    expect(upTo(4)[2].text).toBe("then I can talk again. and once more.");
  });

  it("the final supersedes the provisional run — both folds then agree exactly", () => {
    const finished: IntentEvent[] = [
      ...liveStream(DELTAS, [shot("shot_1", T0 + 1000 + 20)]),
      { at: T0 + 3000, type: "talk-end", segment: 1, ms: 3000 },
      {
        at: T0 + 3000 + LAG,
        type: "transcript-final",
        segment: 1,
        text: "Okay, this is a demo. Then I can talk again. And once more.",
        latencyMs: LAG,
        model: "rt",
      },
    ];
    const streaming = composeIntent(finished, "replace", STREAMING).items;
    const committed = composeIntent(finished).items;
    // Once a segment is final, `streaming` changes nothing at all: no
    // provisional run survives, and the preview shows what will be sent.
    expect(streaming).toEqual(committed);
    expect(streaming.some((i) => i.provisional)).toBe(false);
    expect(committed[0].kind).toBe("text");
    expect(committed.some((i) => i.kind === "shot")).toBe(true);
  });

  it("a REST transcriber has no deltas: nothing is provisional, shots keep arrival order", () => {
    const events: IntentEvent[] = [
      { at: T0 - 10, type: "armed", on: true },
      { at: T0 - 5, type: "thread-open", trigger: "talk" },
      { at: T0, type: "talk-start", segment: 1 },
      shot("shot_1", T0 + 1000),
      { at: T0 + 2000, type: "talk-end", segment: 1, ms: 2000 },
      {
        at: T0 + 2600,
        type: "transcript-final",
        segment: 1,
        text: "one two",
        latencyMs: 600,
        model: "rest",
      },
    ];
    const items = composeIntent(events, "replace", STREAMING).items;
    expect(items.map((i) => i.kind)).toEqual(["shot", "text"]);
    expect(items.some((i) => i.provisional)).toBe(false);
  });

  it("keeps a whitespace-only delta out of the fold", () => {
    expect(composeIntent(liveStream([[T0 + 500, "   "]]), "replace", STREAMING).items).toEqual([]);
  });
});

describe("linter events (observations, never content)", () => {
  it("composeIntent ignores all linter-* kinds — the fold is unchanged by them", () => {
    const engine = armedEngine();
    const s1 = engine.talkStart() ?? 1;
    engine.talkEnd();
    engine.transcriptFinal(s1, "make the plot wider", 90, "rt");
    const without = composeIntent(engine.events);

    engine.events.push(
      { at: 100, type: "linter-note", text: "ambiguous: which plot?", segment: s1 },
      { at: 101, type: "linter-tool-call", tool: "read_file", args: { path: "src/plot.ts" } },
      {
        at: 102,
        type: "linter-tool-result",
        tool: "read_file",
        ok: true,
        summary: "src/plot.ts — 2.1KB",
      },
    );
    const withLinter = composeIntent(engine.events);
    expect(withLinter.prompt).toBe(without.prompt);
    expect(withLinter.transcript).toBe(without.transcript);
    expect(withLinter.items).toEqual(without.items);
  });

  it("linter events are not contentful: a selection refinement keeps its marker across them", () => {
    const engine = armedEngine();
    engine.talkStart();
    engine.appSelection({ text: "the histogram title" });
    // A lint lands between the selection and its refinement — the refinement
    // must still supersede under the SAME marker (one chip tracking a drag).
    engine.events.push({ at: 50, type: "linter-note", text: "clear so far" });
    engine.appSelection({ text: "the histogram title and axis" });
    const markers = engine.events
      .filter((e) => e.type === "app-selection")
      .map((e) => (e as { marker?: string }).marker);
    expect(markers).toEqual(["sel_1", "sel_1"]);
  });
});

describe("the extension host's verbs (§13.6 — explicit turns, send keeps armed)", () => {
  it("openTurn opens exactly one explicit thread, armed-only", () => {
    const engine = new Engine();
    expect(engine.openTurn()).toBe(false); // unarmed: refused
    expect(engine.events.some((e) => e.type === "thread-open")).toBe(false);

    engine.setArmed(true);
    expect(engine.openTurn()).toBe(true);
    const opens = engine.events.filter((e) => e.type === "thread-open");
    expect(opens).toHaveLength(1);
    expect(opens[0]).toMatchObject({ trigger: "explicit" });

    expect(engine.openTurn()).toBe(true); // already open: no second thread
    expect(engine.events.filter((e) => e.type === "thread-open")).toHaveLength(1);
  });

  it("send({ keepArmed: true }) closes the thread but stays armed", () => {
    const engine = new Engine();
    engine.setArmed(true);
    engine.openTurn();
    engine.contribute("hello");
    engine.send({ keepArmed: true });
    expect(engine.threadOpen).toBe(false);
    expect(engine.armed).toBe(true); // §13.6: the next ⌘B starts the next turn
    expect(engine.events.at(-1)).toMatchObject({ type: "thread-close", reason: "send" });

    // The overlay's default is unchanged: a plain send() disarms.
    engine.openTurn();
    engine.send();
    expect(engine.armed).toBe(false);
  });

  it("onEvent returns an unsubscribe that actually detaches", () => {
    const engine = new Engine();
    const seen: string[] = [];
    const off = engine.onEvent((event) => seen.push(event.type));
    engine.setArmed(true);
    expect(seen).toEqual(["armed"]);
    off();
    engine.setArmed(false);
    expect(seen).toEqual(["armed"]); // nothing after detach
  });
});
