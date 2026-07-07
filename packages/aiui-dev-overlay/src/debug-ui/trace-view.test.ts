// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { IntentEvent } from "../intent-pipeline";
import type { LiveTrace } from "./sources";
import { TraceView } from "./trace-view";

const events: IntentEvent[] = [
  { at: 1, type: "thread-open", trigger: "talk" },
  { at: 2, type: "talk-start", segment: 1 },
  { at: 3, type: "transcript-final", segment: 1, text: "make it wider", latencyMs: 20, model: "m" },
  { at: 4, type: "correction", via: "typed", original: "beat", instruction: "vite" },
];

const patch = [
  "*** Begin Patch",
  "*** Update File: transcript",
  "@@",
  "-Here's another chunk of text.",
  "+Here's another piece of text.",
  "*** End Patch",
].join("\n");

const loweredText =
  "This prompt was sent from the aiui web intent tool running in a web app under development.\n\n" +
  "The source code of the web app in that tab is located at: /proj\n\n" +
  "The user's prompt follows.\n\n---\n\n" +
  'make this wider <screenshot path=".aiui-cache/traces/trace-42/shot_1.png"/> please';

/** A rich, completed intent-v1 trace exercising most card types. */
function fullTrace(over: Partial<LiveTrace> = {}): LiveTrace {
  return {
    rev: 1,
    id: "trace-42",
    format: "intent-v1",
    threadId: "th-1",
    actor: "human",
    status: "completed",
    startedAt: "2026-07-06T18:00:00.000Z",
    endedAt: "2026-07-06T18:00:06.900Z",
    stages: [
      {
        kind: "info",
        label: "client context",
        data: { tab: { url: "http://x/", title: "X" }, actor: "human" },
      },
      {
        kind: "info",
        label: "intent config",
        data: { tier: "standard", transcriber: "openai", corrector: "openai" },
      },
      { kind: "input", label: "frame 0 events", file: "input-0.bin" },
      { kind: "input", label: "frame 1 audio", file: "input-1.bin" },
      { kind: "input", label: "frame 2 audio", file: "input-2.bin" },
      { kind: "input", label: "frame 3 audio", file: "input-3.bin" },
      {
        kind: "ir",
        label: "composed (speculative)",
        data: { transcript: "make it", prompt: "make it" },
      },
      {
        kind: "ir",
        label: "composed (speculative)",
        data: { transcript: "make it wider", prompt: "make it wider" },
      },
      {
        kind: "ir",
        label: "correction patch",
        data: { model: "gpt-4o-mini", latencyMs: 1541, patch },
      },
      { kind: "ir", label: "attachment shot_1", file: "shot_1.png" },
      { kind: "ir", label: "merged events", data: events },
      {
        kind: "info",
        label: "speech ack_0",
        data: { mime: "audio/mpeg", bytes: 1234, text: "sent" },
      },
      { kind: "output", label: "lowered prompt", data: loweredText },
    ],
    ...over,
  };
}

const mount = (): TraceView =>
  new TraceView({
    blobUrl: (id, f) => `http://host/blob/${id}/${f}`,
    previewUrl: (p) => `http://host/pv?p=${p}`,
  });

describe("TraceView — status header", () => {
  it("headlines a sent turn with format, duration, and stage count", () => {
    const view = mount();
    view.update(fullTrace());
    const outcome = view.root.querySelector(".aiui-dbg-outcome");
    expect(outcome?.textContent).toContain("sent");
    expect(outcome?.classList.contains("state-sent")).toBe(true);
    const meta = view.root.querySelector(".aiui-dbg-status-meta")?.textContent ?? "";
    expect(meta).toContain("intent-v1");
    expect(meta).toContain("6.9s");
    expect(meta).toContain("13 stages");
  });

  it("marks a cancelled turn and shows the no-prompt hero note", () => {
    const view = mount();
    view.update(
      fullTrace({
        stages: [{ kind: "ir", label: "conditioned", data: { cancelled: true } }],
      }),
    );
    expect(view.root.querySelector(".aiui-dbg-outcome")?.textContent).toContain("cancelled");
    expect(view.root.querySelector(".aiui-dbg-hero-none")?.textContent).toContain("cancelled");
  });
});

describe("TraceView — the prompt hero", () => {
  it("renders the body with a dimmed preamble and a screenshot thumbnail off the blob route", () => {
    const view = mount();
    view.update(fullTrace());
    const preamble = view.root.querySelector(".aiui-dbg-hero-preamble")?.textContent ?? "";
    expect(preamble).toContain("The user's prompt follows.");
    const body = view.root.querySelector(".aiui-dbg-hero-body");
    expect(body?.textContent).toContain("make this wider");
    // The <screenshot> block became an <img> pointing at the stable trace blob.
    const img = body?.querySelector<HTMLImageElement>(".aiui-dbg-shot img");
    expect(img?.getAttribute("src")).toBe("http://host/blob/trace-42/shot_1.png");
  });
});

describe("TraceView — cards, coalescing, filters", () => {
  it("coalesces audio frames and hides audio + compose by default", () => {
    const view = mount();
    view.update(fullTrace());
    const titles = [...view.root.querySelectorAll(".aiui-dbg-card-title")].map(
      (e) => e.textContent,
    );
    // Default story: no audio stream, no speculative compose.
    expect(titles).not.toContain("audio stream");
    expect(titles).not.toContain("speculative compose");
    // But the merged-events and correction cards are there.
    expect(titles).toContain("merged events");
    expect(titles).toContain("correction patch");
  });

  it("reveals the coalesced audio card (×3) when the audio chip is toggled on", () => {
    const view = mount();
    view.update(fullTrace());
    const audioChip = view.root.querySelector<HTMLButtonElement>('[data-cat="audio"]');
    audioChip?.click();
    const audioCard = [...view.root.querySelectorAll(".aiui-dbg-card")].find(
      (c) => c.querySelector(".aiui-dbg-card-title")?.textContent === "audio stream",
    );
    expect(audioCard).toBeTruthy();
    expect(audioCard?.querySelector(".aiui-dbg-card-count")?.textContent).toBe("×3");
  });

  it("filters by direction lane", () => {
    const view = mount();
    view.update(fullTrace());
    view.root.querySelector<HTMLButtonElement>('[data-dir="out"]')?.click();
    const titles = [...view.root.querySelectorAll(".aiui-dbg-card-title")].map(
      (e) => e.textContent,
    );
    // Out lane = server → browser pushes only; the lowered prompt lives in
    // its own agent lane now, so it filters out here too.
    expect(titles).toContain("speech");
    expect(titles).not.toContain("lowered prompt");
    expect(titles).not.toContain("merged events");
    expect(titles).not.toContain("client context");

    view.root.querySelector<HTMLButtonElement>('[data-dir="agent"]')?.click();
    const agentTitles = [...view.root.querySelectorAll(".aiui-dbg-card-title")].map(
      (e) => e.textContent,
    );
    expect(agentTitles).toContain("lowered prompt");
    expect(agentTitles).not.toContain("speech");
  });

  it("renders the merged-events card with an event-type summary and correction line", () => {
    const view = mount();
    view.update(fullTrace());
    const card = [...view.root.querySelectorAll(".aiui-dbg-card")].find(
      (c) => c.querySelector(".aiui-dbg-card-title")?.textContent === "merged events",
    );
    expect(card?.querySelector(".aiui-dbg-card-info")?.textContent).toContain("4 events");
    const subs = [...(card?.querySelectorAll(".aiui-dbg-card-sub") ?? [])].map(
      (s) => s.textContent,
    );
    expect(subs.some((s) => s?.includes("transcript-final"))).toBe(true);
    expect(subs.some((s) => s?.includes("beat") && s?.includes("vite"))).toBe(true);
  });

  it("renders a correction patch as a red/green diff", () => {
    const view = mount();
    view.update(fullTrace());
    expect(view.root.querySelector(".aiui-dbg-patch-line.del")?.textContent).toContain(
      "Here's another chunk of text.",
    );
    expect(view.root.querySelector(".aiui-dbg-patch-line.add")?.textContent).toContain(
      "Here's another piece of text.",
    );
  });

  it("renders a saved screenshot blob as a clickable image card", () => {
    const view = mount();
    view.update(fullTrace());
    const img = view.root.querySelector<HTMLImageElement>(".aiui-dbg-card-img");
    expect(img?.getAttribute("src")).toBe("http://host/blob/trace-42/shot_1.png");
  });
});

describe("TraceView — selection cards", () => {
  const infoOf = (view: TraceView, title: string): string =>
    [...view.root.querySelectorAll(".aiui-dbg-card")]
      .filter((c) => c.querySelector(".aiui-dbg-card-title")?.textContent === title)
      .map((c) => c.querySelector(".aiui-dbg-card-info")?.textContent ?? "")
      .join(" | ");

  it("renders marked app/code selections and their drops as one-line cards", () => {
    const view = mount();
    view.update(
      fullTrace({
        stages: [
          {
            kind: "ir",
            label: "app selection",
            data: {
              marker: "sel_1",
              text: "the histogram title",
              sourceLoc: "src/Hist.tsx:10:2",
              cell: "hist",
            },
          },
          { kind: "ir", label: "app selection dropped", data: { marker: "sel_1" } },
          {
            kind: "ir",
            label: "code selection",
            data: { marker: "code_1", text: "const x = 1;", sourceLoc: "src/a.ts:5:1" },
          },
          { kind: "ir", label: "code selection dropped", data: { marker: "code_1" } },
        ],
      }),
    );
    expect(infoOf(view, "app selection")).toContain(
      "sel_1 · “the histogram title” @ src/Hist.tsx:10:2 · cell hist",
    );
    expect(infoOf(view, "app selection dropped")).toContain("sel_1 retracted");
    expect(infoOf(view, "code selection")).toContain("code_1 · src/a.ts:5:1 · “const x = 1;”");
    expect(infoOf(view, "code selection dropped")).toContain("code_1 retracted");
  });

  it("degrades old-shape stages (markerless / missing fields) instead of crashing", () => {
    const view = mount();
    view.update(
      fullTrace({
        stages: [
          // A pre-marker trace: no marker, sparse fields.
          { kind: "ir", label: "app selection", data: { text: "old style" } },
          // The retired whole-turn drop: empty data.
          { kind: "ir", label: "app selection dropped", data: {} },
          // A code selection with nothing but text.
          { kind: "ir", label: "code selection", data: { text: "let y;" } },
        ],
      }),
    );
    expect(infoOf(view, "app selection")).toContain("“old style”");
    expect(infoOf(view, "app selection dropped")).toContain("retracted");
    expect(infoOf(view, "code selection")).toContain("“let y;”");
  });
});

describe("TraceView — live-follow state survival", () => {
  it("keeps an opened raw disclosure open across a re-render", () => {
    const view = mount();
    view.update(fullTrace());
    // Open the merged-events card's raw disclosure.
    const card = [...view.root.querySelectorAll(".aiui-dbg-card")].find(
      (c) => c.querySelector(".aiui-dbg-card-title")?.textContent === "merged events",
    );
    const details = card?.querySelector<HTMLDetailsElement>(".aiui-dbg-card-raw");
    expect(details).toBeTruthy();
    if (details) {
      details.open = true;
      details.dispatchEvent(new Event("toggle"));
    }
    // A poll update re-renders; the same card's disclosure must still be open.
    view.update(fullTrace({ rev: 2 }));
    const after = [...view.root.querySelectorAll(".aiui-dbg-card")].find(
      (c) => c.querySelector(".aiui-dbg-card-title")?.textContent === "merged events",
    );
    expect(after?.querySelector<HTMLDetailsElement>(".aiui-dbg-card-raw")?.open).toBe(true);
  });

  it("keeps a toggled filter across a re-render", () => {
    const view = mount();
    view.update(fullTrace());
    view.root.querySelector<HTMLButtonElement>('[data-cat="audio"]')?.click(); // audio on
    view.update(fullTrace({ rev: 2 }));
    const titles = [...view.root.querySelectorAll(".aiui-dbg-card-title")].map(
      (e) => e.textContent,
    );
    expect(titles).toContain("audio stream");
  });
});

/** A realtime-submode trace: live session, video flood, a model-composed tool call. */
function realtimeTrace(over: Partial<LiveTrace> = {}): LiveTrace {
  return {
    rev: 1,
    id: "trace-live-7",
    format: "intent-v1",
    threadId: "th-live",
    actor: "human",
    status: "completed",
    startedAt: "2026-07-06T18:00:00.000Z",
    endedAt: "2026-07-06T18:01:30.000Z",
    stages: [
      {
        kind: "info",
        label: "live open",
        data: {
          vendor: "gemini",
          model: "gemini-3.1-flash-live-preview",
          capabilities: { video: true },
        },
      },
      { kind: "input", label: "frame 0 video" },
      { kind: "input", label: "frame 10 video", file: "vid_1_10.jpg" },
      { kind: "input", label: "frame 20 video", file: "vid_1_20.jpg" },
      { kind: "info", label: "live label shot_3" },
      { kind: "info", label: "live nudge", data: { text: "the user pressed send — submit now" } },
      {
        kind: "ir",
        label: "live tool call",
        data: {
          segments: [{ text: "make " }, { image: "shot_3" }, { text: " the legend bigger" }],
        },
      },
      {
        kind: "ir",
        label: "live resolved",
        data: {
          body: "make the legend bigger",
          refs: [{ marker: "shot_3", path: "/x/shot_3.png" }],
        },
      },
      { kind: "info", label: "live reply", data: { text: "sure, enlarging the legend" } },
      { kind: "output", label: "lowered prompt", data: "make the legend bigger" },
    ],
    ...over,
  };
}

describe("TraceView — realtime submode", () => {
  it("headlines a realtime turn as sent (lowered prompt present via the resolve path)", () => {
    const view = mount();
    view.update(realtimeTrace());
    expect(view.root.querySelector(".aiui-dbg-outcome")?.textContent).toContain("sent");
  });

  it("renders the tool call's segments as prose interleaved with shot chips", () => {
    const view = mount();
    view.update(realtimeTrace());
    const card = [...view.root.querySelectorAll(".aiui-dbg-card")].find(
      (c) => c.querySelector(".aiui-dbg-card-title")?.textContent === "live tool call",
    );
    expect(card).toBeTruthy();
    const seg = card?.querySelector(".aiui-dbg-live-seg");
    expect(seg?.textContent).toContain("make");
    expect(seg?.textContent).toContain("the legend bigger");
    // The image ref became an inline chip, not raw text.
    const chips = [...(seg?.querySelectorAll(".aiui-dbg-live-chip") ?? [])].map(
      (c) => c.textContent,
    );
    expect(chips).toEqual(["🖼 shot_3"]);
  });

  it("shows the resolved card (agent lane) with its ref counts", () => {
    const view = mount();
    view.update(realtimeTrace());
    const card = [...view.root.querySelectorAll(".aiui-dbg-card")].find(
      (c) => c.querySelector(".aiui-dbg-card-title")?.textContent === "live resolved",
    );
    expect(card?.classList.contains("dir-agent")).toBe(true);
    expect(card?.querySelector(".aiui-dbg-card-info")?.textContent).toContain("make the legend");
    expect(card?.querySelector(".aiui-dbg-card-sub")?.textContent).toContain("1 ref resolved");
  });

  it("hides the video-stream card by default and reveals its saved keyframes on toggle", () => {
    const view = mount();
    view.update(realtimeTrace());
    const titles = () =>
      [...view.root.querySelectorAll(".aiui-dbg-card-title")].map((e) => e.textContent);
    expect(titles()).not.toContain("video stream");
    view.root.querySelector<HTMLButtonElement>('[data-cat="video"]')?.click();
    const card = [...view.root.querySelectorAll(".aiui-dbg-card")].find(
      (c) => c.querySelector(".aiui-dbg-card-title")?.textContent === "video stream",
    );
    expect(card?.querySelector(".aiui-dbg-card-count")?.textContent).toBe("×3");
    // Only the two saved keyframes render as thumbnails (frame 0 wasn't saved).
    const thumbs = [...(card?.querySelectorAll(".aiui-dbg-video-thumbs img") ?? [])].map((i) =>
      i.getAttribute("src"),
    );
    expect(thumbs).toEqual([
      "http://host/blob/trace-live-7/vid_1_10.jpg",
      "http://host/blob/trace-live-7/vid_1_20.jpg",
    ]);
  });
});

describe("TraceView — empty", () => {
  it("shows a hint when nothing is selected", () => {
    const view = mount();
    view.update(undefined);
    expect(view.root.textContent).toContain("Select a trace");
    expect(view.root.querySelector(".aiui-dbg-filters")?.hasAttribute("hidden")).toBe(true);
  });
});
