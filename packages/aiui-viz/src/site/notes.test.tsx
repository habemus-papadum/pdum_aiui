// @vitest-environment jsdom
/**
 * notes.test.tsx — the collision pass (pure), the overlay's rows, and the
 * layer mounted over stubbed geometry: notes land on their anchors in both
 * layouts, a colliding note is pushed right with its leader kept, a changed
 * `version` re-measures, and a note that grows (through the resize seam)
 * re-runs the pass.
 */
import { render } from "@solidjs/web";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { disposeDurable } from "../durable";
import { tick } from "../testing";
import { anchorPoint, NoteLayer, type NoteSpec, overlayRows, resolveNoteShifts } from "./notes";

// ── doubles ──────────────────────────────────────────────────────────────────

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  readonly observed = new Set<Element>();
  readonly observe = vi.fn((el: Element) => {
    this.observed.add(el);
  });
  readonly unobserve = vi.fn((el: Element) => {
    this.observed.delete(el);
  });
  readonly disconnect = vi.fn(() => this.observed.clear());
  constructor(private readonly cb: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this);
  }
  report(el: Element, width: number, height: number): void {
    const entry = { target: el, contentRect: { width, height } } as unknown as ResizeObserverEntry;
    this.cb([entry], this as unknown as ResizeObserver);
  }
}

const frames = new Map<number, FrameRequestCallback>();
let nextFrame = 1;
function runFrames(): void {
  const pending = [...frames.values()];
  frames.clear();
  for (const cb of pending) cb(0);
}

/** Geometry by element: `data-rect="left,top,width,height"` on anchors and
 * hosts; a note's width by its `data-for` (height 16). */
const noteWidths: Record<string, number> = {};
function rectOf(el: Element): DOMRect {
  const attr = el.getAttribute("data-rect");
  let left = 0;
  let top = 0;
  let width = 0;
  let height = 0;
  if (attr !== null) {
    [left, top, width, height] = attr.split(",").map(Number) as [number, number, number, number];
  } else if (el.classList.contains("aiui-note")) {
    width = noteWidths[el.getAttribute("data-for") ?? ""] ?? 40;
    height = 16;
  }
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

let dispose: (() => void) | undefined;
beforeEach(() => {
  FakeResizeObserver.instances = [];
  frames.clear();
  nextFrame = 1;
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    const id = nextFrame++;
    frames.set(id, cb);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    frames.delete(id);
  });
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    return rectOf(this);
  });
});
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
  for (const k of Object.keys(noteWidths)) delete noteWidths[k];
  disposeDurable("aiui:resize-observer", (b) =>
    (b as { observer?: ResizeObserver }).observer?.disconnect(),
  );
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const style = (el: Element | null, v: string): string | undefined =>
  (el as HTMLElement | null)?.style.getPropertyValue(v);

// ── pure ─────────────────────────────────────────────────────────────────────

describe("resolveNoteShifts — notes pushed apart, left to right", () => {
  it("leaves separated notes alone and moves an overlapping one right by the least that clears", () => {
    const shifts = resolveNoteShifts(
      [
        { id: "a", anchor: 50, width: 60 },
        { id: "b", anchor: 200, width: 60 },
        { id: "c", anchor: 230, width: 60 }, // would span 200..260 over b's 170..230
      ],
      10,
    );
    expect([...shifts]).toEqual([
      ["a", 0],
      ["b", 0],
      ["c", 40], // left edge 240 = b's right 230 + the gap; center 270 vs anchor 230
    ]);
  });

  it("orders by anchor, not by input, and chains the push", () => {
    const shifts = resolveNoteShifts(
      [
        { id: "late", anchor: 120, width: 100 },
        { id: "early", anchor: 100, width: 100 },
        { id: "last", anchor: 140, width: 100 },
      ],
      0,
    );
    expect(shifts.get("early")).toBe(0); // 50..150
    expect(shifts.get("late")).toBe(80); // pushed to 150..250, center 200
    expect(shifts.get("last")).toBe(160); // pushed to 250..350, center 300
  });
});

describe("anchorPoint and overlayRows", () => {
  const box = { left: 10, top: 20, width: 100, height: 40 };
  it("attaches at the box's edge midpoints", () => {
    expect(anchorPoint(box, "below")).toEqual({ x: 60, y: 60 });
    expect(anchorPoint(box, "above")).toEqual({ x: 60, y: 20 });
    expect(anchorPoint(box, "left")).toEqual({ x: 10, y: 40 });
    expect(anchorPoint(box, "right")).toEqual({ x: 110, y: 40 });
  });
  it("groups above/below notes by their band of y and never left/right ones", () => {
    const it_ = (id: string, side: "below" | "above" | "left", y: number) => ({
      id,
      side,
      anchor: 0,
      width: 50,
      y,
      height: 16,
    });
    const rows = overlayRows([
      it_("a", "below", 50),
      it_("b", "below", 52),
      it_("c", "below", 140), // a rank further down
      it_("d", "above", 50),
      it_("e", "left", 50),
    ]);
    expect(rows.map((r) => r.map((x) => x.id))).toEqual([["a", "b"], ["c"], ["d"]]);
  });
});

// ── the layer ────────────────────────────────────────────────────────────────

interface Rig {
  host: HTMLElement;
  root: HTMLElement;
  setVersion: (v: number) => void;
  setNotes: (n: NoteSpec[]) => void;
}

function mount(layout: "margin" | "overlay", notes: NoteSpec[], hostRect: string): Rig {
  const [version, setVersion] = createSignal(0);
  const [specs, setNotes] = createSignal(notes);
  let host!: HTMLElement;
  const root = document.createElement("div");
  document.body.append(root);
  dispose = render(
    () => (
      <div class="rtx">
        <div
          class="host"
          data-rect={hostRect}
          ref={(el) => {
            host = el;
          }}
        >
          <span data-id="x" data-rect="40,10,20,20" />
          <span data-id="y" data-rect="70,10,20,20" />
          <span data-id="z" data-rect="40,100,20,20" />
        </div>
        <NoteLayer
          layout={layout}
          side="below"
          host={() => host}
          anchorOf={(id) => host.querySelector(`[data-id="${id}"]`) ?? undefined}
          notes={specs()}
          version={version()}
        />
      </div>
    ),
    root,
  );
  return { host, root, setVersion, setNotes };
}

const spec = (id: string, side?: NoteSpec["side"], active?: boolean): NoteSpec => ({
  id,
  side,
  active,
  note: <i class={`n-${id}`}>{id}</i>,
});

describe("<NoteLayer layout=margin>", () => {
  it("renders its side's notes at their anchors with leaders to the strip's edge", async () => {
    noteWidths.x = 20;
    noteWidths.y = 20;
    const r = mount(
      "margin",
      [spec("x"), spec("y", "below", true), spec("z", "above")],
      "0,0,200,60",
    );
    const layer = r.root.querySelector(".aiui-notes") as HTMLElement;
    expect(layer.className).toBe("aiui-notes aiui-notes-margin aiui-notes-below");
    const x = r.root.querySelector(".aiui-note[data-for=x]") as HTMLElement;
    const y = r.root.querySelector(".aiui-note[data-for=y]") as HTMLElement;
    expect(r.root.querySelector(".aiui-note[data-for=z]")).toBeNull(); // the other side's
    expect(x.querySelector("i.n-x")?.textContent).toBe("x");
    expect(x.classList.contains("aiui-note-below")).toBe(true);
    expect(x.style.visibility).toBe("hidden"); // not yet measured
    expect(y.getAttribute("data-active")).toBe("true");
    expect(x.hasAttribute("data-active")).toBe(false);

    runFrames();
    await tick();
    expect(x.style.visibility).toBe("");
    expect(style(x, "--aiui-note-x")).toBe("50"); // the anchor's center
    expect(style(x, "--aiui-note-w")).toBe("20");
    expect(style(x, "--aiui-note-leader")).toBe("30"); // host height 60 − anchor bottom 30
    expect(style(x, "--aiui-note-shift")).toBe("0");
    expect(style(y, "--aiui-note-x")).toBe("80");
    expect(style(y, "--aiui-note-shift")).toBe("0"); // 20 px wide, 30 px apart: no collision
  });

  it("pushes a colliding note right, re-measures on a new version, and on a note growing", async () => {
    noteWidths.x = 60;
    noteWidths.y = 60;
    const r = mount("margin", [spec("x"), spec("y")], "0,0,200,60");
    runFrames();
    await tick();
    const x = r.root.querySelector(".aiui-note[data-for=x]") as HTMLElement;
    const y = r.root.querySelector(".aiui-note[data-for=y]") as HTMLElement;
    // x spans 20..80; y wants 50..110 → its left goes to 80 + 8, center 118 vs anchor 80.
    expect(style(x, "--aiui-note-shift")).toBe("0");
    expect(style(y, "--aiui-note-shift")).toBe("38");

    // The anchors moved (a re-render): the consumer bumps the version.
    (r.host.querySelector('[data-id="y"]') as HTMLElement).setAttribute(
      "data-rect",
      "150,10,20,20",
    );
    r.setVersion(1);
    await tick();
    runFrames();
    await tick();
    expect(style(y, "--aiui-note-x")).toBe("160");
    expect(style(y, "--aiui-note-shift")).toBe("0");

    // The first note grows (a number gaining digits): its observed size
    // changes, the pass re-runs, and now it reaches y again.
    const ro = FakeResizeObserver.instances[0] as FakeResizeObserver;
    expect(ro.observed.has(x)).toBe(true);
    noteWidths.x = 220;
    ro.report(x, 220, 16);
    await tick();
    runFrames();
    await tick();
    // x spans −60..160; y wants 130..190 → left 168, center 198 vs anchor 160.
    expect(style(y, "--aiui-note-shift")).toBe("38");
  });
});

describe("<NoteLayer layout=overlay>", () => {
  it("places each note at its side's anchor point and runs the pass per rank", async () => {
    noteWidths.x = 60;
    noteWidths.y = 60;
    noteWidths.z = 60;
    const r = mount("overlay", [spec("x"), spec("y"), spec("z", "below")], "0,0,400,300");
    const layer = r.root.querySelector(".aiui-notes") as HTMLElement;
    expect(layer.className).toBe("aiui-notes aiui-notes-overlay");
    runFrames();
    await tick();
    const x = r.root.querySelector(".aiui-note[data-for=x]") as HTMLElement;
    const y = r.root.querySelector(".aiui-note[data-for=y]") as HTMLElement;
    const z = r.root.querySelector(".aiui-note[data-for=z]") as HTMLElement;
    expect(style(x, "--aiui-note-x")).toBe("50");
    expect(style(x, "--aiui-note-y")).toBe("30"); // below: the anchor's bottom
    expect(style(y, "--aiui-note-shift")).toBe("38"); // same rank as x: pushed
    expect(style(z, "--aiui-note-x")).toBe("50");
    expect(style(z, "--aiui-note-y")).toBe("120");
    expect(style(z, "--aiui-note-shift")).toBe("0"); // another rank: left alone
    expect(style(x, "--aiui-note-leader")).toBe("0"); // overlays have no strip edge
  });

  it("anchors left and right notes at the box's sides", async () => {
    const r = mount("overlay", [spec("x", "left"), spec("y", "right")], "0,0,400,300");
    runFrames();
    await tick();
    const x = r.root.querySelector(".aiui-note[data-for=x]") as HTMLElement;
    const y = r.root.querySelector(".aiui-note[data-for=y]") as HTMLElement;
    expect(x.classList.contains("aiui-note-left")).toBe(true);
    expect(style(x, "--aiui-note-x")).toBe("40");
    expect(style(x, "--aiui-note-y")).toBe("20");
    expect(y.classList.contains("aiui-note-right")).toBe(true);
    expect(style(y, "--aiui-note-x")).toBe("90");
  });

  it("hides a note whose anchor is gone and drops the layer with the last note", async () => {
    const r = mount("overlay", [spec("x"), spec("q")], "0,0,400,300");
    runFrames();
    await tick();
    const q = r.root.querySelector(".aiui-note[data-for=q]") as HTMLElement;
    expect(q.style.visibility).toBe("hidden"); // no element `q` to anchor to
    r.setNotes([]);
    await tick();
    expect(r.root.querySelector(".aiui-notes")).toBeNull();
  });
});
