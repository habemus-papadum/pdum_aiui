// @vitest-environment jsdom
/**
 * panes.test.tsx — the preview's and trace's live behaviors, each a bug shape:
 *  - the trace count that sat at zero on a live turn (reads must go through
 *    the cursor);
 *  - the preview's revision flash (appends never animate, rewrites diff);
 *  - the heat row (a final carrying logprobs re-keys its row — the retired
 *    overlay's live lesson: without the `:w` key suffix the plain row survives
 *    the final and the heat branch is unreachable);
 *  - the RESET rule (the accumulator is per-turn: closing the thread empties
 *    the preview — found live as navigations haunting a closed turn);
 *  - the chips: shots as thumbnails, selections as pills, navigations as ⇢
 *    route markers (the retired overlay's visual language, now living here).
 */
import type { IntentEvent } from "@habemus-papadum/aiui-lowering-pipeline";
import { render } from "@solidjs/web";
import { createSignal, flush } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import type { ChannelLanes } from "../lanes";
import { TracePane } from "./panes";
import { TurnPreview } from "./turn-preview";

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.replaceChildren();
});

/** A fake lanes cursor over a hand-fed thread (what lanes.ts really does). */
function fakeThread() {
  const events: IntentEvent[] = [];
  const [rev, setRev] = createSignal(0);
  const dropped: string[] = [];
  const engine = {
    events,
    // What lanes.ts's wire engine really exposes: a plain property the
    // component must read UNDER the cursor to see change.
    get threadOpen() {
      for (let i = events.length - 1; i >= 0; i--) {
        if (events[i].type === "thread-open") {
          return true;
        }
        if (events[i].type === "thread-close") {
          return false;
        }
      }
      return false;
    },
    dropShot: (marker: string) => dropped.push(`shot:${marker}`),
    appSelectionDrop: (marker?: string) => dropped.push(`sel:${marker}`),
    dropCodeSelection: (marker: string) => dropped.push(`code:${marker}`),
  };
  const lanes = {
    eventsRev: rev,
    threadEvents: () => {
      void rev();
      for (let i = events.length - 1; i >= 0; i--) {
        if (events[i].type === "thread-open") {
          return events.slice(i);
        }
      }
      return [];
    },
    engine,
  } as unknown as ChannelLanes;
  const push = (...next: IntentEvent[]) => {
    events.push(...next);
    setRev((n) => n + 1);
    flush();
  };
  return { lanes, push, dropped };
}

const open = (): IntentEvent[] => [
  { at: 0, type: "armed", on: true },
  { at: 1, type: "thread-open", trigger: "explicit" },
];

describe("TurnPreview — the accumulator's live behaviors", () => {
  it("appends render clean; a REVISION flashes the word-diff and settles", () => {
    const { lanes, push } = fakeThread();
    const root = document.createElement("div");
    document.body.append(root);
    dispose = render(() => <TurnPreview lanes={lanes} />, root);

    push(...open(), { at: 2, type: "talk-start", segment: 1 });
    push({ at: 3, type: "transcript-delta", segment: 1, text: "make the panel" });
    expect(root.textContent).toContain("make the panel");
    expect(root.querySelector(".mm-diff-add")).toBeNull(); // an append never animates

    // The transcriber revises itself: the diff runs appear (pink del, green
    // add), then settle to clean text on the island's own clock.
    push({ at: 4, type: "transcript-delta", segment: 1, text: "make the panel wider" });
    expect(root.querySelector(".mm-diff-add")).toBeNull(); // still an extension
    push({ at: 5, type: "transcript-delta", segment: 1, text: "make the RING wider" });
    expect(root.querySelector(".mm-diff-del")?.textContent).toContain("panel");
    expect(root.querySelector(".mm-diff-add")?.textContent).toContain("RING");
  });

  it("a final WITH logprobs re-keys its row into a heat row (the `:w` lesson)", () => {
    const { lanes, push } = fakeThread();
    const root = document.createElement("div");
    document.body.append(root);
    dispose = render(() => <TurnPreview lanes={lanes} />, root);

    push(...open(), { at: 2, type: "talk-start", segment: 1 });
    push({ at: 3, type: "transcript-delta", segment: 1, text: "make it wider" });
    expect(root.querySelector("[data-testid=heat-row]")).toBeNull();

    push({
      at: 4,
      type: "transcript-final",
      segment: 1,
      text: "make it wider",
      latencyMs: 10,
      model: "scribe",
      words: [
        { text: "make", logprob: -0.05 },
        { text: "it", logprob: -0.1 },
        { text: "wider", logprob: -2.4 }, // the unsure word
      ],
    });
    const heat = root.querySelector("[data-testid=heat-row]");
    expect(heat).not.toBeNull();
    // The unsure word is tinted; the confident one is not — normalized against
    // the turn's own range.
    const spans = [...(heat?.querySelectorAll("span[title^=logprob]") ?? [])] as HTMLElement[];
    const byText = new Map(spans.map((s) => [s.textContent, s.style.background]));
    expect(byText.get("wider")).toContain("rgba(255, 92, 135");
    expect(byText.get("make") ?? "").toBe("");
  });

  it("RESETS when the thread closes — an abandoned turn stops haunting the preview", () => {
    const { lanes, push } = fakeThread();
    const root = document.createElement("div");
    document.body.append(root);
    dispose = render(() => <TurnPreview lanes={lanes} />, root);

    push(...open(), { at: 2, type: "transcript-delta", segment: 1, text: "hello there" });
    expect(root.textContent).toContain("hello there");

    // Abandon. The accumulator is per-turn: nothing may survive the close —
    // found live as navigation chips piling into a preview whose turn died.
    push({ at: 3, type: "thread-close", reason: "cancel" });
    expect(root.textContent).not.toContain("hello there");
    expect(root.textContent).toContain("no open turn");
    push({ at: 4, type: "navigation", from: "https://a.test/x", to: "https://a.test/y" });
    expect(root.textContent).toContain("turn preview — 0 items");

    // A NEW turn starts clean.
    push({ at: 5, type: "thread-open", trigger: "explicit" });
    expect(root.textContent).toContain("empty turn (send would cancel)");
  });

  it("renders the accumulator chips: shot thumbnail, selection pill, ⇢ navigation", () => {
    const { lanes, push, dropped } = fakeThread();
    const root = document.createElement("div");
    document.body.append(root);
    dispose = render(() => <TurnPreview lanes={lanes} />, root);

    push(
      ...open(),
      {
        at: 2,
        type: "shot",
        marker: "shot_1",
        rect: { x: 0, y: 0, w: 8, h: 8 },
        components: [],
        thumb: "data:image/png;base64,x",
      },
      {
        at: 3,
        type: "app-selection",
        marker: "sel_1",
        text: "the selected words",
        url: "https://a.test/",
      },
      { at: 4, type: "navigation", from: "https://a.test/from", to: "https://a.test/to?q=1" },
    );

    const thumb = root.querySelector("[data-testid=shot-chip] img") as HTMLImageElement;
    expect(thumb?.src).toContain("data:image/png");
    expect(root.querySelector("[data-testid=selection-chip]")?.textContent).toContain("⌖ sel_1");
    const nav = root.querySelector("[data-testid=nav-chip]");
    expect(nav?.textContent?.trim()).toBe("⇢"); // a chip carries NO data — icon only
    expect(nav?.getAttribute("title")).toContain("/from"); // the data rides the hover

    // The hover ✕ retracts through the WIRE engine — the same drop verbs the
    // retired overlay used, now living behind this repo's component.
    (root.querySelector("[data-testid=shot-chip] .aiui-tp-x") as HTMLButtonElement)?.click();
    (root.querySelector("[data-testid=selection-chip] .aiui-tp-x") as HTMLButtonElement)?.click();
    expect(dropped).toEqual(["shot:shot_1", "sel:sel_1"]);
  });
});

describe("TracePane", () => {
  it("counts events as they arrive (every read goes through the cursor)", () => {
    const events: Array<{ type: string; at: number }> = [];
    const [rev, setRev] = createSignal(0);
    const lanes = {
      eventsRev: rev,
      engine: { events },
    } as unknown as ChannelLanes;

    const root = document.createElement("div");
    document.body.append(root);
    dispose = render(() => <TracePane lanes={lanes} />, root);

    expect(root.textContent).toContain("trace — 0 events");

    // The wire pushes an event and bumps the cursor — exactly what lanes.ts does.
    events.push({ type: "thread-open", at: 0 });
    setRev((n) => n + 1);
    flush();
    expect(root.textContent).toContain("trace — 1 event");

    events.push({ type: "shot", at: 1 });
    setRev((n) => n + 1);
    flush();
    expect(root.textContent).toContain("trace — 2 events");
  });
});
