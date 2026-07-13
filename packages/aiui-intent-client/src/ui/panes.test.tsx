// @vitest-environment jsdom
/**
 * panes.test.tsx — the trace pane's count, which sat at zero on a live turn
 * while events poured in. The engine's event log is a plain array the wire
 * pushes to; the ONLY thing that makes reading it reactive is going through
 * the lanes' `eventsRev` cursor. A JSX expression that reads `.length`
 * straight off the array subscribes to nothing and renders once, forever.
 */
import { render } from "@solidjs/web";
import { createSignal, flush } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import type { ChannelLanes } from "../lanes";
import { TracePane } from "./panes";

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
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
