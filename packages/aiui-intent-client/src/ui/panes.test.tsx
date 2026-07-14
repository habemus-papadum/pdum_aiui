// @vitest-environment jsdom
/**
 * panes.test.tsx — the panes' live behaviors, each a bug shape:
 *  - the trace count that sat at zero on a live turn (reads must go through
 *    the cursor);
 *  - the preview's revision flash (appends never animate, rewrites diff);
 *  - the heat row (a final carrying logprobs re-keys its row — the overlay's
 *    live lesson: without the `:w` key suffix the plain row survives the
 *    final and the heat branch is unreachable).
 */
import type { IntentEvent } from "@habemus-papadum/aiui-dev-overlay/intent-pipeline";
import { render } from "@solidjs/web";
import { createSignal, flush } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import type { ChannelLanes } from "../lanes";
import { TracePane, TurnPane } from "./panes";

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
  const lanes = {
    eventsRev: rev,
    threadEvents: () => {
      void rev();
      return [...events];
    },
    engine: { events },
  } as unknown as ChannelLanes;
  const push = (...next: IntentEvent[]) => {
    events.push(...next);
    setRev((n) => n + 1);
    flush();
  };
  return { lanes, push };
}

const open = (): IntentEvent[] => [
  { at: 0, type: "armed", on: true },
  { at: 1, type: "thread-open", trigger: "explicit" },
];

describe("TurnPane — the preview's live text", () => {
  it("appends render clean; a REVISION flashes the word-diff and settles", () => {
    const { lanes, push } = fakeThread();
    const root = document.createElement("div");
    document.body.append(root);
    dispose = render(() => <TurnPane lanes={lanes} />, root);

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
    dispose = render(() => <TurnPane lanes={lanes} />, root);

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
