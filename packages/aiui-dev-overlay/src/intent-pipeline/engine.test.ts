import { describe, expect, it, vi } from "vitest";
import { composeIntent, Engine, renderAppSelection, renderCodeSelection } from "./engine";

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
    });
    const composed = composeIntent(engine.events);
    expect(composed.prompt).toBe(
      "make this wider " +
        'Regarding the on-screen selection "the histogram title" ' +
        "(authored at src/Hist.tsx:10:2; produced by cell hist)",
    );
    // Selection text is never transcript text — corrections can't touch it.
    expect(composed.transcript).toBe("make this wider");
  });

  it("fences a long selection and carries the TeX attribution", () => {
    const engine = armedEngine();
    engine.talkStart();
    const long = "a very long run of selected page text ".repeat(10).trim();
    engine.appSelection({ text: long, sourceLoc: "src/Doc.tsx:3:1", tex: "\\frac{a}{b}" });
    const composed = composeIntent(engine.events);
    expect(composed.prompt).toContain(
      "Regarding this on-screen selection " +
        "(authored at src/Doc.tsx:3:1; rendered mathematics — TeX source: \\frac{a}{b}):\n" +
        `\`\`\`\n${long}\n\`\`\``,
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

  it("is a no-op without an open thread (a selection rides a turn, never opens one)", () => {
    const engine = armedEngine();
    expect(engine.appSelection({ text: "stray" })).toBe(false);
    expect(engine.appSelectionDrop()).toBe(false);
    expect(engine.threadOpen).toBe(false);
    expect(engine.events.some((e) => e.type === "app-selection")).toBe(false);
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
    expect(composed.prompt).toBe("Regarding `src/a.ts:5:1`: `const x = 1;`");
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
    expect(composed.prompt).toBe("Regarding `src/b.ts:2:2`: `const b = 2;`");
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
    expect(composed.prompt).toContain("Regarding `src/b.ts:10-21` (12 lines):\n```\n");
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
    engine.correction({ from: 11, to: 15, original: "curb" }, "curve", "typed");

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

  it("renderAppSelection: short → inline sentence with the attribution parenthetical", () => {
    expect(
      renderAppSelection({
        text: "the histogram title",
        sourceLoc: "src/Hist.tsx:10:2",
        cell: "hist",
      }),
    ).toBe(
      'Regarding the on-screen selection "the histogram title" ' +
        "(authored at src/Hist.tsx:10:2; produced by cell hist)",
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

  it("renderCodeSelection: short → inline; long → fenced under its locator", () => {
    expect(renderCodeSelection({ text: "const x = 1;", sourceLoc: "src/a.ts:5:1" })).toBe(
      "Regarding `src/a.ts:5:1`: `const x = 1;`",
    );
    const code = Array.from({ length: 12 }, (_, i) => `line ${i} of something long enough`).join(
      "\n",
    );
    const block = renderCodeSelection({ text: code, sourceLoc: "src/b.ts:10-21", lines: 12 });
    expect(block).toContain("Regarding `src/b.ts:10-21` (12 lines):\n```\n");
    expect(block).toContain(`${code}\n\`\`\``);
  });
});
