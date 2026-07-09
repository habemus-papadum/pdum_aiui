// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { Ink } from "./ink";
import { locateComponents, ShotTool } from "./shot";

afterEach(() => {
  delete window.__AIUI__;
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

/** jsdom has no layout: pin an element's viewport box for the containment math. */
function stubRect(el: Element, box: { x: number; y: number; w: number; h: number }): void {
  (el as HTMLElement).getBoundingClientRect = () =>
    ({
      x: box.x,
      y: box.y,
      left: box.x,
      top: box.y,
      right: box.x + box.w,
      bottom: box.y + box.h,
      width: box.w,
      height: box.h,
      toJSON: () => ({}),
    }) as DOMRect;
}

/** An annotated element appended to `parent` with a pinned box. */
function annotated(
  parent: Element,
  attrs: { cell?: string; loc?: string },
  box: { x: number; y: number; w: number; h: number },
): HTMLElement {
  const el = document.createElement("div");
  if (attrs.cell) {
    el.setAttribute("data-cell", attrs.cell);
  }
  if (attrs.loc) {
    el.setAttribute("data-source-loc", attrs.loc);
  }
  stubRect(el, box);
  parent.append(el);
  return el;
}

describe("locateComponents (enclosure locator: data-source-loc / data-cell)", () => {
  it("keeps only the highest fully-enclosed elements, with their direct-cell frontier", () => {
    window.__AIUI__ = { v: 1, frames: [], sourceRoot: "/repo/app" };
    // The app shell overlaps every rect — the old grid locator reported it on
    // every shot; enclosure must not.
    const shell = annotated(document.body, { cell: "AppShell" }, { x: 0, y: 0, w: 1000, h: 800 });
    const plot = annotated(
      shell,
      { cell: "SpectrumPlot", loc: "src/ui/Plot.tsx:20:9" },
      { x: 100, y: 100, w: 200, h: 150 },
    );
    // A cell inside the plot: enclosed too, but contained → the plot's frontier,
    // not its own entry. A deeper cell under it must NOT surface (one level).
    const axis = annotated(
      plot,
      { cell: "axis", loc: "src/ui/Axis.tsx:5:1" },
      { x: 110, y: 110, w: 50, h: 50 },
    );
    annotated(axis, { cell: "tickmarks" }, { x: 112, y: 112, w: 10, h: 10 });

    const components = locateComponents({ x: 90, y: 90, w: 250, h: 200 });
    expect(components).toHaveLength(1);
    expect(components[0].component).toBe("SpectrumPlot");
    expect(components[0].source).toBe("/repo/app/src/ui/Plot.tsx:20:9");
    expect(components[0].containment).toBeUndefined();
    expect(components[0].cells).toEqual([
      { name: "axis", source: "/repo/app/src/ui/Axis.tsx:5:1" },
    ]);
  });

  it("names an un-celled element after its authoring module, never a bare tag", () => {
    // The pre-fix failure: a drag framing several panels rendered as
    // `name="div"` × N in the prompt AND in the trace preview's caption —
    // the source stamp was right there, carrying the component's name.
    annotated(document.body, { loc: "src/ui/Controls.tsx:44:7" }, { x: 0, y: 0, w: 100, h: 50 });
    annotated(document.body, { loc: "src/ui/TimeSeries.tsx:55:5" }, { x: 0, y: 60, w: 100, h: 50 });
    // No stamp at all (hand-written page, unstamped element): tag is the last resort.
    const bare = document.createElement("section");
    stubRect(bare, { x: 0, y: 120, w: 100, h: 30 });
    bare.setAttribute("data-cell", ""); // annotated-but-empty: matches the query
    document.body.append(bare);

    const names = locateComponents({ x: -5, y: -5, w: 120, h: 170 }).map((c) => c.component);
    expect(names).toEqual(["Controls", "TimeSeries", "section"]);
  });

  it("falls back to the innermost containing element (within) when nothing is enclosed", () => {
    const shell = annotated(document.body, { cell: "AppShell" }, { x: 0, y: 0, w: 1000, h: 800 });
    annotated(
      shell,
      { cell: "SpectrumPlot", loc: "src/ui/Plot.tsx:20:9" },
      { x: 100, y: 100, w: 600, h: 500 },
    );

    // A drag entirely inside the plot: encloses nothing annotated.
    const components = locateComponents({ x: 200, y: 200, w: 80, h: 60 });
    expect(components).toHaveLength(1);
    expect(components[0].component).toBe("SpectrumPlot"); // innermost, not the shell
    expect(components[0].containment).toBe("within");
  });

  it("a cell's source is its DEFINITION site (data-cell-loc) when stamped, else the JSX approximation", () => {
    window.__AIUI__ = { v: 1, frames: [], sourceRoot: "/repo/app" };
    const host = annotated(
      document.body,
      { loc: "src/ui/Panel.tsx:4:1" },
      { x: 0, y: 0, w: 100, h: 100 },
    );
    // A CellView wrapper carrying the cell's definition site — it must win
    // over the stamped JSX inside it (the old approximation). This is the loc
    // that flows into LocatedCell.source and from there, verbatim, into the
    // composed prompt's <cell source="…"> — the def site, not the usage site.
    const catalog = annotated(host, { cell: "catalog" }, { x: 10, y: 10, w: 50, h: 50 });
    catalog.setAttribute("data-cell-loc", "src/model/graph.ts:77");
    annotated(catalog, { loc: "src/ui/CatalogView.tsx:12:3" }, { x: 12, y: 12, w: 10, h: 10 });
    // A cell with no data-cell-loc (pre-stamp CellView, or a manual data-cell
    // attribute): the first stamped descendant still approximates it.
    const ticks = annotated(host, { cell: "ticks" }, { x: 70, y: 10, w: 20, h: 20 });
    annotated(ticks, { loc: "src/ui/Ticks.tsx:9:5" }, { x: 71, y: 11, w: 5, h: 5 });

    const [component] = locateComponents({ x: 0, y: 0, w: 110, h: 110 });
    expect(component.cells).toEqual([
      { name: "catalog", source: "/repo/app/src/model/graph.ts:77" },
      { name: "ticks", source: "/repo/app/src/ui/Ticks.tsx:9:5" },
    ]);
  });

  it("passes the relative stamp through when no sourceRoot is known", () => {
    annotated(
      document.body,
      { cell: "Legend", loc: "src/ui/Legend.tsx:3:1" },
      { x: 2, y: 2, w: 6, h: 6 },
    );
    const [component] = locateComponents({ x: 0, y: 0, w: 10, h: 10 });
    expect(component.source).toBe("src/ui/Legend.tsx:3:1");
  });
});

/** Stub the getDisplayMedia + canvas stack jsdom lacks, so a shot yields bytes. */
function stubCapture(): () => void {
  const track = { addEventListener() {}, stop() {} };
  const stream = { getVideoTracks: () => [track], getTracks: () => [track] };
  const originalMedia = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
  Object.defineProperty(navigator, "mediaDevices", {
    value: { getDisplayMedia: async () => stream, getUserMedia: async () => stream },
    configurable: true,
  });
  const fakeCtx = new Proxy({}, { get: () => () => {}, set: () => true });
  const canvas = HTMLCanvasElement.prototype as unknown as Record<string, unknown>;
  const media = HTMLMediaElement.prototype as unknown as Record<string, unknown>;
  const saved = {
    getContext: canvas.getContext,
    toBlob: canvas.toBlob,
    toDataURL: canvas.toDataURL,
    play: media.play,
    srcObject: Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "srcObject"),
  };
  canvas.getContext = () => fakeCtx;
  canvas.toBlob = (cb: (b: Blob) => void) =>
    cb(new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: "image/png" }));
  canvas.toDataURL = () => "data:image/png;base64,iVBOR";
  media.play = async () => {};
  Object.defineProperty(HTMLMediaElement.prototype, "srcObject", {
    value: undefined,
    writable: true,
    configurable: true,
  });
  return () => {
    if (originalMedia) {
      Object.defineProperty(navigator, "mediaDevices", originalMedia);
    }
    canvas.getContext = saved.getContext;
    canvas.toBlob = saved.toBlob;
    canvas.toDataURL = saved.toDataURL;
    media.play = saved.play;
    if (saved.srcObject) {
      Object.defineProperty(HTMLMediaElement.prototype, "srcObject", saved.srcObject);
    }
  };
}

describe("ShotTool capture", () => {
  it("hands back raw PNG bytes for the modality to upload", async () => {
    const restore = stubCapture();
    try {
      const ink = new Ink({ fadeSec: () => 0, onStroke: () => {}, onAutoClear: () => {} });
      let received:
        | { components?: unknown[]; viewport?: boolean; thumb?: string; bytes?: Uint8Array }
        | undefined;
      const shots = new ShotTool(ink, (_rect, components, viewport, thumb, bytes) => {
        received = { components, viewport, thumb, bytes };
      });
      await shots.shootViewport();
      expect(received?.bytes).toBeInstanceOf(Uint8Array);
      expect([...(received?.bytes ?? [])]).toEqual([0x89, 0x50, 0x4e, 0x47]);
      // Viewport shots skip the locator entirely and say so.
      expect(received?.viewport).toBe(true);
      expect(received?.components).toEqual([]);
      ink.dispose();
      shots.dispose();
    } finally {
      restore();
    }
  });

  it("degrades to no pixels when capture is unavailable", async () => {
    const ink = new Ink({ fadeSec: () => 0, onStroke: () => {}, onAutoClear: () => {} });
    let received: { bytes?: Uint8Array } | undefined;
    const shots = new ShotTool(ink, (_rect, _components, _viewport, _thumb, bytes) => {
      received = { bytes };
    });
    // jsdom has no getDisplayMedia — the shot still fires, without bytes.
    await shots.shootViewport();
    expect(received?.bytes).toBeUndefined();
    ink.dispose();
    shots.dispose();
  });
});

describe("ShotTool region veil (D arm/disarm)", () => {
  /** Dispatch a pointer event on the veil (jsdom has PointerEvent, no capture API). */
  function pointer(el: HTMLElement, type: string, x: number, y: number): void {
    el.dispatchEvent(
      new PointerEvent(type, { clientX: x, clientY: y, pointerId: 1, bubbles: true }),
    );
  }

  it("hides immediately when disarmed with no drag in progress", () => {
    const ink = new Ink({ fadeSec: () => 0, onStroke: () => {}, onAutoClear: () => {} });
    const shots = new ShotTool(ink, () => {});
    shots.setArmed(true);
    expect(shots.veil.style.display).toBe("block");
    shots.setArmed(false);
    expect(shots.veil.style.display).toBe("none");
    ink.dispose();
    shots.dispose();
  });

  it("defers the disarm when D is released mid-drag: the veil stays up, the capture still runs, then it hides on pointerup", async () => {
    const restore = stubCapture();
    try {
      const ink = new Ink({ fadeSec: () => 0, onStroke: () => {}, onAutoClear: () => {} });
      let shot: { rect: { x: number; y: number; w: number; h: number } } | undefined;
      const shots = new ShotTool(ink, (rect) => {
        shot = { rect };
      });
      document.body.append(shots.veil);
      // jsdom elements have no setPointerCapture; the veil calls it on pointerdown.
      (shots.veil as unknown as { setPointerCapture(id: number): void }).setPointerCapture =
        () => {};

      shots.setArmed(true);
      pointer(shots.veil, "pointerdown", 10, 10);
      pointer(shots.veil, "pointermove", 110, 80);
      expect(shots.dragInProgress()).toBe(true);

      // D up WHILE the pointer is still down: hiding now would drop the shot, so
      // the disarm is deferred — the veil stays visible.
      shots.setArmed(false);
      expect(shots.veil.style.display).toBe("block");
      expect(shots.dragInProgress()).toBe(true);

      // pointerup finishes the region capture, then the deferred disarm fires.
      pointer(shots.veil, "pointerup", 110, 80);
      expect(shots.veil.style.display).toBe("none");
      expect(shots.dragInProgress()).toBe(false);

      await new Promise((resolve) => setTimeout(resolve, 200)); // grab()'s compositor beat
      expect(shot?.rect).toMatchObject({ x: 10, y: 10, w: 100, h: 70 });

      ink.dispose();
      shots.dispose();
    } finally {
      restore();
    }
  });
});
