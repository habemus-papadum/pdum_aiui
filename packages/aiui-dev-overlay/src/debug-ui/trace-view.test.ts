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

    // Structured stage data renders as the collapsible JSON tree, not a <pre>.
    const tree = view.root.querySelector(".aiui-dbg-json");
    expect(tree).toBeTruthy();
    expect(tree?.querySelector(".aiui-dbg-json-key")?.textContent).toBe("talkMode");
    expect(tree?.querySelector(".aiui-dbg-json-string")?.textContent).toBe('"hold"');
    expect(view.root.querySelector(".aiui-dbg-tbody pre")).toBeNull();

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
    // Plain-string stage data keeps the flat <pre> rendering — no tree chrome.
    expect(view.root.querySelectorAll(".aiui-dbg-tbody pre")).toHaveLength(2);
    expect(view.root.querySelector(".aiui-dbg-json")).toBeNull();
  });

  it("keeps string leaves inside the tree path-interactive (previewUrl injected)", () => {
    const view = new TraceView({ previewUrl: (p) => `http://host/preview?p=${p}` });
    view.update({
      rev: 1,
      id: "t",
      format: "intent-v1",
      threadId: "th",
      stages: [
        {
          kind: "output",
          label: "attachments",
          data: { shots: ["/tmp/aiui/shot_1.png"], note: "see above" },
        },
      ],
    });
    const path = view.root.querySelector(".aiui-dbg-json .aiui-dbg-path");
    expect(path?.textContent).toBe("/tmp/aiui/shot_1.png");
    expect(path?.classList.contains("img")).toBe(true);
  });

  it("shows an empty hint when nothing is selected", () => {
    const view = new TraceView();
    view.update(undefined);
    expect(view.root.textContent).toContain("Select a trace");
  });
});
