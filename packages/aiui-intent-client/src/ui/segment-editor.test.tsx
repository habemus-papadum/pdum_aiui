// @vitest-environment jsdom
/**
 * segment-editor.test.tsx — the popup's semantics, mostly through its PURE
 * halves (snapshot → collect → plan), plus one integration row driving the
 * mounted component: fix text + delete an atom in one Apply, and watch the
 * right verbs hit the wire engine. The contract rows:
 *  - the snapshot shows one segment's text with its interleaved items as atoms;
 *  - MOVING an atom changes nothing (positions are the compiler's);
 *  - DELETING an atom is a delete command;
 *  - Apply replaces the text with retimed words (kept words keep their times);
 *  - a pasted image anchors by the words around it.
 */
import type { IntentEvent } from "@habemus-papadum/aiui-lowering-pipeline";
import { render } from "@solidjs/web";
import { createSignal, flush } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import type { ChannelLanes } from "../lanes";
import { collectEditable, planEdit, SegmentEditor, segmentSnapshot } from "./segment-editor";

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.replaceChildren();
});

const T0 = 1000;
/** A spoken segment with words + a shot anchored mid-text (the fixture the
 * pipeline tests use, seen from the panel side). */
function spokenThread(): IntentEvent[] {
  return [
    { at: T0 - 10, type: "armed", on: true },
    { at: T0 - 5, type: "thread-open", trigger: "talk" },
    { at: T0, type: "talk-start", segment: 1 },
    { at: T0 + 900, type: "transcript-delta", segment: 1, text: "make the legend" },
    { at: T0 + 2400, type: "transcript-delta", segment: 1, text: "make the legend wider now" },
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

describe("segmentSnapshot", () => {
  it("shows one segment's text with its interleaved items as atoms, in order", () => {
    const snap = segmentSnapshot(spokenThread(), 1);
    expect(snap).toBeDefined();
    expect(snap?.blocks.map((b) => b.kind)).toEqual(["text", "atom", "text"]);
    expect(snap?.blocks[0]).toMatchObject({ text: "make the legend" });
    expect(snap?.blocks[1]).toMatchObject({ atom: { itemKind: "shot", marker: "shot_1" } });
    expect(snap?.oldWords).toHaveLength(5);
    expect(snap?.windowStart).toBe(T0);
  });

  it("returns undefined for a segment that composed no text", () => {
    expect(segmentSnapshot(spokenThread(), 99)).toBeUndefined();
  });
});

/** A fake editable surface: text nodes + atom spans, as the component builds. */
function surface(
  parts: Array<string | { marker: string; itemKind?: string } | { pasteId: string }>,
): HTMLElement {
  const root = document.createElement("div");
  for (const part of parts) {
    if (typeof part === "string") {
      root.append(document.createTextNode(part));
    } else {
      const span = document.createElement("span");
      span.contentEditable = "false";
      if ("pasteId" in part) {
        span.dataset.pasteId = part.pasteId;
      } else {
        span.dataset.marker = part.marker;
        span.dataset.itemKind = part.itemKind ?? "shot";
      }
      span.textContent = "🖼";
      root.append(span);
    }
  }
  return root;
}

describe("collect + plan (the editor's pure semantics)", () => {
  const snap = () => {
    const s = segmentSnapshot(spokenThread(), 1);
    if (s === undefined) {
      throw new Error("fixture segment missing");
    }
    return s;
  };

  it("unchanged text + surviving atom = an empty plan (moves are ignored)", () => {
    // The atom MOVED to the front — the plan must not care.
    const collected = collectEditable(
      surface([{ marker: "shot_1" }, " make the legend ", "wider now"]),
    );
    const plan = planEdit(snap(), collected);
    expect(plan.replace).toBeUndefined();
    expect(plan.deleted).toEqual([]);
    expect(plan.pastes).toEqual([]);
  });

  it("edited text replaces with retimed words — kept words keep their times", () => {
    const collected = collectEditable(
      surface(["make the caption ", { marker: "shot_1" }, " wider now"]),
    );
    const plan = planEdit(snap(), collected);
    expect(plan.replace?.text).toBe("make the caption wider now");
    const words = plan.replace?.words ?? [];
    expect(words.map((w) => w.text)).toEqual(["make", "the", "caption", "wider", "now"]);
    expect(words[0]).toMatchObject({ startMs: 0, endMs: 400 }); // kept
    expect(words[3]).toMatchObject({ startMs: 1600, endMs: 2000 }); // kept
    expect(words[2].logprob).toBeUndefined(); // the fix is typed, not guessed
  });

  it("a deleted atom becomes a delete command", () => {
    const collected = collectEditable(surface(["make the legend wider now"]));
    const plan = planEdit(snap(), collected);
    expect(plan.deleted).toEqual([{ itemKind: "shot", marker: "shot_1" }]);
  });

  it("a pasted image anchors to the word before it", () => {
    const collected = collectEditable(
      surface([
        "make the ",
        { pasteId: "paste_1" },
        " legend ",
        { marker: "shot_1" },
        " wider now",
      ]),
    );
    const plan = planEdit(snap(), collected);
    // After token 2 ("the", ends 700ms): takenAt = windowStart + 700.
    expect(plan.pastes).toEqual([{ pasteId: "paste_1", takenAt: T0 + 700 }]);
  });

  it("a paste at the very start anchors to the window open", () => {
    const collected = collectEditable(
      surface([{ pasteId: "paste_1" }, " make the legend wider now"]),
    );
    const plan = planEdit(snap(), collected);
    expect(plan.pastes).toEqual([{ pasteId: "paste_1", takenAt: T0 }]);
  });
});

describe("SegmentEditor (integration)", () => {
  it("Apply speaks segment-replace + the drop verb through the engine", () => {
    const events = spokenThread();
    const calls: string[] = [];
    const [rev] = createSignal(0);
    const lanes = {
      eventsRev: rev,
      threadEvents: () => events,
      engine: {
        events,
        threadOpen: true,
        replaceSegment: (segment: number, text: string, words: unknown[]) =>
          calls.push(`replace:${segment}:${text}:${words.length}w`),
        dropShot: (marker: string) => calls.push(`drop:${marker}`),
        appSelectionDrop: (marker?: string) => calls.push(`selDrop:${marker}`),
        dropCodeSelection: (marker: string) => calls.push(`codeDrop:${marker}`),
        contribute: (text: string) => calls.push(`contribute:${text}`),
      },
      wire: { uploadAttachment: () => Promise.resolve() },
    } as unknown as ChannelLanes;

    let closed = false;
    dispose = render(
      () => (
        <SegmentEditor
          lanes={lanes}
          mode={{ kind: "segment", segment: 1 }}
          onClose={() => {
            closed = true;
          }}
        />
      ),
      document.body,
    );
    flush();

    // The user: fixes "legend" → "caption" AND deletes the shot atom.
    const editable = document.querySelector(".aiui-se-text") as HTMLElement;
    expect(editable.querySelector("[data-marker=shot_1]")).not.toBeNull();
    editable.querySelector("[data-marker=shot_1]")?.remove();
    for (const node of Array.from(editable.childNodes)) {
      if (node.textContent?.includes("legend")) {
        node.textContent = node.textContent.replace("legend", "caption");
      }
    }
    (document.querySelector("[data-testid=editor-apply]") as HTMLButtonElement).click();

    expect(calls).toEqual(["replace:1:make the caption wider now:5w", "drop:shot_1"]);
    expect(closed).toBe(true);
  });

  it("is MODAL for the keyboard: keys under the popup never reach the grammar below", () => {
    const [rev] = createSignal(0);
    const lanes = {
      eventsRev: rev,
      threadEvents: () => [],
      engine: { events: [], threadOpen: true, contribute: () => {} },
      wire: { uploadAttachment: () => Promise.resolve() },
    } as unknown as ChannelLanes;
    // The shell's grammar listens at DOCUMENT capture; the editor claims
    // window capture ahead of it. Found live: arrows blipped and letters
    // dispatched commands while the popup was open.
    const reached: string[] = [];
    const shellLike = (event: KeyboardEvent) => reached.push(event.key);
    document.addEventListener("keydown", shellLike, true);
    try {
      dispose = render(
        () => <SegmentEditor lanes={lanes} mode={{ kind: "append" }} onClose={() => {}} />,
        document.body,
      );
      flush();
      const editable = document.querySelector(".aiui-se-text") as HTMLElement;
      editable.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true }),
      );
      editable.dispatchEvent(
        new KeyboardEvent("keydown", { key: "d", bubbles: true, cancelable: true }),
      );
      expect(reached).toEqual([]); // the grammar under the popup heard nothing
    } finally {
      document.removeEventListener("keydown", shellLike, true);
    }
  });

  it("append mode contributes the typed text", () => {
    const calls: string[] = [];
    const [rev] = createSignal(0);
    const lanes = {
      eventsRev: rev,
      threadEvents: () => [],
      engine: {
        events: [],
        threadOpen: true,
        contribute: (text: string) => calls.push(`contribute:${text}`),
      },
      wire: { uploadAttachment: () => Promise.resolve() },
    } as unknown as ChannelLanes;

    dispose = render(
      () => <SegmentEditor lanes={lanes} mode={{ kind: "append" }} onClose={() => {}} />,
      document.body,
    );
    flush();
    const editable = document.querySelector(".aiui-se-text") as HTMLElement;
    editable.append(document.createTextNode("also check the docs"));
    (document.querySelector("[data-testid=editor-apply]") as HTMLButtonElement).click();
    expect(calls).toEqual(["contribute:also check the docs"]);
  });
});
