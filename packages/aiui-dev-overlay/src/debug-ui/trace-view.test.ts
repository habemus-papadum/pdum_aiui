// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { IntentEvent } from "../intent-pipeline";
import type { LiveTrace } from "./sources";
import { TraceView } from "./trace-view";

const events: IntentEvent[] = [
  { at: 1, type: "thread-open", trigger: "talk" },
  {
    at: 2,
    type: "transcript-final",
    segment: 1,
    text: "make it wider",
    latencyMs: 20,
    model: "mock",
  },
];

describe("TraceView", () => {
  it("renders generic stages and embeds event panes for an event-log stage", () => {
    const view = new TraceView({ blobUrl: (id, f) => `http://host/blob/${id}/${f}` });
    const trace: LiveTrace = {
      rev: 1,
      id: "trace-42",
      format: "intent-v1",
      threadId: "th-1",
      status: "completed",
      stages: [
        {
          at: new Date().toISOString(),
          kind: "input",
          label: "config",
          data: { talkMode: "hold" },
        },
        { at: new Date().toISOString(), kind: "input", label: "event log", data: events },
        { at: new Date().toISOString(), kind: "output", label: "shot", file: "shot_1.png" },
      ],
    };
    view.update(trace);

    // Header reflects the manifest.
    expect(view.root.querySelector("h2")?.textContent).toContain("intent-v1");

    // The event-log stage becomes the full event panes (with tabs).
    expect(view.root.querySelector(".aiui-dbg-tabs")).toBeTruthy();
    expect(view.root.textContent).toContain("make it wider");

    // The blob stage resolves through the injected blobUrl.
    const img = view.root.querySelector<HTMLImageElement>("img");
    expect(img?.getAttribute("src")).toBe("http://host/blob/trace-42/shot_1.png");
  });

  it("renders a plain text-concat trace with no event log", () => {
    const view = new TraceView();
    view.update({
      rev: 1,
      id: "t",
      format: "text-concat",
      threadId: "th",
      stages: [
        { kind: "input", label: "chunk", data: "hello " },
        { kind: "output", label: "prompt", data: "hello world" },
      ],
    });
    expect(view.root.querySelector(".aiui-dbg-tabs")).toBeNull(); // no event panes
    expect(view.root.textContent).toContain("hello world");
  });

  it("shows an empty hint when nothing is selected", () => {
    const view = new TraceView();
    view.update(undefined);
    expect(view.root.textContent).toContain("Select a trace");
  });
});
