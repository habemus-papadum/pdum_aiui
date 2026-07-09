// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
// Real captured interaction streams (recorded in the retired workbench lab). Imported
// statically so vite resolves them at the module's location — jsdom mangles the
// runtime `import.meta.url` these tests would otherwise resolve against.
import cancelTurn from "../../fixtures/cancel-turn.json";
import fullTurnSend from "../../fixtures/full-turn-send.json";
import plainDictation from "../../fixtures/plain-dictation.json";
import type { IntentEvent } from "../intent-pipeline";
import { EventPanes } from "./event-panes";
import { staticSource } from "./sources";

const fixtures: Record<string, IntentEvent[]> = {
  "cancel-turn": cancelTurn as IntentEvent[],
  "full-turn-send": fullTurnSend as IntentEvent[],
  "plain-dictation": plainDictation as IntentEvent[],
};
const fixture = (name: keyof typeof fixtures): IntentEvent[] => fixtures[name];

function paneText(panes: EventPanes, name: string): string {
  return panes.root.querySelector<HTMLElement>(`.aiui-dbg-${name}`)?.textContent ?? "";
}

describe("EventPanes", () => {
  it("populates every pane from a captured fixture", () => {
    const events = fixture("full-turn-send");
    const panes = new EventPanes();
    panes.update(events);

    // events pane: one row per event (up to the 200 cap).
    const rows = panes.root.querySelectorAll(".aiui-dbg-events .aiui-dbg-ev");
    expect(rows.length).toBe(events.length);
    expect(paneText(panes, "events")).toContain("thread OPEN (talk)");

    // IR pane: composed transcript + the lowered Option-C body.
    const ir = paneText(panes, "ir");
    expect(ir).toContain("make the baseline curve a bit thicker and color it amber");
    expect(ir).toContain("S3 · lowered prompt");
    // This fixture's shot has no saved path → it degrades to an inline bracket.
    expect(ir).toContain("shot_1");

    // timing pane: the two mock STT calls show up.
    expect(paneText(panes, "timing")).toContain("stt  seg 1  mock");
  });

  it("round-trips the stream through export", () => {
    const events = fixture("plain-dictation");
    const panes = new EventPanes();
    panes.update(events);
    expect(JSON.parse(panes.exportJson())).toEqual(events);
  });

  it("binds to a DebugSource and renders on emission", () => {
    const events = fixture("cancel-turn");
    const panes = new EventPanes();
    const unbind = panes.bind(staticSource(events));
    expect(panes.root.querySelectorAll(".aiui-dbg-events .aiui-dbg-ev").length).toBe(events.length);
    unbind();
  });

  it("switches panes on tab click", () => {
    const panes = new EventPanes();
    panes.update(fixture("plain-dictation"));
    const irTab = panes.root.querySelector<HTMLButtonElement>('[data-pane="ir"]');
    irTab?.click();
    expect(panes.root.querySelector<HTMLElement>(".aiui-dbg-ir")?.hidden).toBe(false);
    expect(panes.root.querySelector<HTMLElement>(".aiui-dbg-events")?.hidden).toBe(true);
  });

  it("describes selection events (markers + drops) and places them on the IR timeline", () => {
    const panes = new EventPanes();
    panes.update([
      { at: 1, type: "thread-open", trigger: "talk" },
      {
        at: 2,
        type: "app-selection",
        marker: "sel_1",
        text: "the histogram title",
        sourceLoc: "src/Hist.tsx:10:2",
      },
      {
        at: 3,
        type: "transcript-final",
        segment: 1,
        text: "make it wider",
        latencyMs: 5,
        model: "mock",
      },
      {
        at: 4,
        type: "code-selection",
        marker: "code_1",
        text: "const x = 1;",
        sourceLoc: "src/a.ts:5:1",
      },
      { at: 5, type: "code-selection-drop", marker: "code_1" },
      { at: 6, type: "app-selection-drop", marker: "sel_1" },
    ]);
    const eventsText = paneText(panes, "events");
    expect(eventsText).toContain("sel_1: “the histogram title” @ src/Hist.tsx:10:2");
    expect(eventsText).toContain("code_1 @ src/a.ts:5:1");
    expect(eventsText).toContain("code_1 retracted (✕ on the chip)");
    expect(eventsText).toContain("sel_1 retracted (✕ on the chip)");
    // Both drops retracted their items — the timeline shows only the text run.
    const ir = paneText(panes, "ir");
    expect(ir).toContain("“make it wider”");
    expect(ir).not.toContain("sel_1");
    expect(ir).not.toContain("code_1");
  });

  it("tolerates pre-marker streams (markerless selections, whole-turn drops)", () => {
    const panes = new EventPanes();
    panes.update([
      { at: 1, type: "thread-open", trigger: "talk" },
      { at: 2, type: "app-selection", text: "old style selection" },
      { at: 3, type: "app-selection-drop" },
      { at: 4, type: "app-selection", text: "the survivor" },
    ]);
    const eventsText = paneText(panes, "events");
    expect(eventsText).toContain("app selection: “old style selection”");
    expect(eventsText).toContain("app selection retracted (✕ on the chip)");
    // The IR pane folds legacy latest-wins: the survivor sits on the timeline.
    const ir = paneText(panes, "ir");
    expect(ir).toContain("[sel: “the survivor”]");
  });
});
