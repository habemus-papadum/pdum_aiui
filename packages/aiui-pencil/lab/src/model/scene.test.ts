// @vitest-environment jsdom
import { PencilSurface, type PenSample, WRITE } from "@habemus-papadum/aiui-pencil";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PadRenderer } from "./pad-renderer";
import { LabScene, type LabSceneState } from "./scene";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

/** Models the pending writes of Solid signals: event logic cannot read its own publication. */
function deferred<T>(value: T) {
  let pending = value;
  return {
    get: () => value,
    set: (next: T) => {
      pending = next;
    },
    pending: () => pending,
  };
}

function setup(zoomEnabled = () => true, localInput = false) {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn(() => 1),
  );
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  const state = deferred<LabSceneState>({
    content: { x: 0, y: 0, scale: 1 },
    ink: { x: 0, y: 0, scale: 1 },
    scrollTop: 0,
    scrollLeft: 0,
  });
  const valid = deferred(true);
  let scene: LabScene | undefined;
  const paper = new PencilSurface({
    localInput,
    params: () => WRITE,
    onViewportChange: (viewport) => scene?.viewportChanged(viewport),
  });
  const pad = new PadRenderer();
  scene = new LabScene({
    paper,
    pad,
    state,
    valid,
    linked: () => true,
    width: () => 640,
    zoomEnabled,
  });
  const host = document.createElement("div");
  host.innerHTML = '<div class="scene-scroll"><article class="scene-content"></article></div>';
  document.body.append(host);
  scene.mount(host);
  const controller = scene;
  cleanups.push(() => {
    controller.dispose();
    paper.dispose();
    pad.dispose();
  });
  return {
    scene: controller,
    paper,
    state,
    valid,
    content: host.querySelector<HTMLElement>(".scene-content") as HTMLElement,
  };
}

describe("LabScene view synchronization", () => {
  it("owns Ctrl+wheel pinch, preserves its ink anchor, and follows with linked content", () => {
    const { scene, paper, state } = setup();
    scene.scrollBy(100);
    paper.setViewport({ x: 20, y: -80, scale: 1.5, rotation: 0.3 });
    vi.spyOn(paper.canvas, "getBoundingClientRect").mockReturnValue({
      left: 40,
      top: 60,
    } as DOMRect);
    const point = { x: 190, y: 260 };
    const before = paper.view.clientToInk(point);
    const documentBefore = paper.document.snapshot();
    const wheel = new WheelEvent("wheel", {
      ctrlKey: true,
      deltaY: -30,
      clientX: point.x,
      clientY: point.y,
      cancelable: true,
    });
    paper.canvas.dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(true);
    expect(paper.view.getViewport().scale).toBeGreaterThan(1.5);
    expect(paper.view.getViewport().rotation).toBeCloseTo(0.3);
    expect(paper.view.clientToInk(point).x).toBeCloseTo(before.x);
    expect(paper.view.clientToInk(point).y).toBeCloseTo(before.y);
    expect(state.pending().content.scale).toBe(paper.view.getViewport().scale);
    expect(state.pending().scrollTop).toBe(100);
    expect(paper.document.snapshot()).toBe(documentBefore);
  });

  it("clamps pinch zoom without moving unlinked content or changing scroll behavior", () => {
    const { scene, paper, state } = setup();
    scene.linkedChanged(false);
    for (const [deltaY, scale] of [
      [-100000, 10],
      [100000, 0.1],
    ]) {
      paper.canvas.dispatchEvent(new WheelEvent("wheel", { ctrlKey: true, deltaY }));
      expect(paper.view.getViewport().scale).toBe(scale);
      expect(state.pending().content.scale).toBe(1);
    }
    const wheel = new WheelEvent("wheel", {
      deltaX: 2,
      deltaY: 3,
      deltaMode: 1,
      cancelable: true,
    });
    paper.canvas.dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(true);
    expect(state.pending()).toMatchObject({ scrollLeft: 32, scrollTop: 48 });
    expect(paper.view.getViewport().scale).toBe(0.1);
  });

  it("suppresses page pinch while zoom is disabled or a stroke is unfinished", () => {
    let zoom = false;
    const { paper } = setup(() => zoom);
    const pinch = () => {
      const wheel = new WheelEvent("wheel", {
        ctrlKey: true,
        deltaY: -30,
        cancelable: true,
      });
      paper.canvas.dispatchEvent(wheel);
      expect(wheel.defaultPrevented).toBe(true);
    };
    const before = paper.view.getViewport();
    pinch();
    expect(paper.view.getViewport()).toEqual(before);
    zoom = true;
    paper.document.begin("active", {
      tool: "draw",
      params: WRITE,
      point: {
        x: 10,
        y: 20,
        t: 0,
        pressure: 0.6,
        altitude: Math.PI / 2,
        azimuth: 0,
        twist: 0,
        kind: "pen",
        width: 1,
        height: 1,
      },
    });
    const draft = paper.document.snapshot().live[0];
    pinch();
    expect(paper.view.getViewport()).toEqual(before);
    expect(paper.document.snapshot().live[0]).toBe(draft);
    paper.document.finish("active");
    pinch();
    expect(paper.view.getViewport().scale).toBeGreaterThan(before.scale);
  });

  it("hands a mouse draft to pinch on the first wheel event without committing it on lift", () => {
    const { paper } = setup(() => true, true);
    const pointer = (type: string, pressure: number) =>
      paper.canvas.dispatchEvent(
        new PointerEvent(type, {
          pointerId: 1,
          pointerType: "mouse",
          button: 0,
          pressure,
          clientX: 10,
          clientY: 20,
          bubbles: true,
          cancelable: true,
        }),
      );
    pointer("pointerdown", 0.5);
    expect(paper.document.snapshot().live).toHaveLength(1);
    const wheel = new WheelEvent("wheel", { ctrlKey: true, deltaY: -30, cancelable: true });
    paper.canvas.dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(true);
    expect(paper.view.getViewport().scale).toBeGreaterThan(1);
    expect(paper.document.snapshot().live).toHaveLength(0);
    pointer("pointermove", 0.5);
    pointer("pointerup", 0);
    expect(paper.document.snapshot().strokes).toHaveLength(0);
    expect(paper.input?.counts()).toMatchObject({ began: 1, ended: 0, cancelled: 1 });
    // A later ordinary mouse stroke still starts immediately and commits normally.
    pointer("pointerdown", 0.5);
    expect(paper.document.snapshot().live).toHaveLength(1);
    pointer("pointerup", 0);
    expect(paper.document.snapshot().strokes).toHaveLength(1);
  });

  it.each([
    { pressure: 0.501960813999176 },
    { pressure: 0.5, altitudeAngle: Math.PI / 3, azimuthAngle: 0 },
  ])("keeps mouse-labelled pen evidence intact during pinch: %j", (evidence) => {
    const { paper } = setup(() => true, true);
    paper.canvas.dispatchEvent(
      new PointerEvent("pointerdown", {
        pointerId: 1,
        pointerType: "mouse",
        button: 0,
        clientX: 10,
        clientY: 20,
        ...evidence,
      }),
    );
    const draft = paper.document.snapshot().live[0];
    const view = paper.view.getViewport();
    paper.canvas.dispatchEvent(new WheelEvent("wheel", { ctrlKey: true, deltaY: -30 }));
    expect(paper.document.snapshot().live[0]).toBe(draft);
    expect(paper.view.getViewport()).toEqual(view);
    expect(paper.input?.counts().cancelled).toBe(0);
  });

  it("updates ink and CSS transforms immediately even when durable publications are deferred", () => {
    const { scene, paper, state, content } = setup();
    scene.scrollBy(200);
    expect(state.get().scrollTop).toBe(0);
    expect(state.pending().scrollTop).toBe(200);
    expect(paper.view.getViewport().y).toBe(-200);
    paper.setViewport({ x: 20, y: -160, scale: 1.5, rotation: 0.2 });
    expect(state.pending().content).toEqual({ x: 20, y: 40, scale: 1.5, rotation: 0.2 });
    expect(content.style.transform).toContain(", 20, 40)");
    scene.resetView();
    expect(paper.view.getViewport()).toMatchObject({ x: 0, y: 0, scale: 1 });
    expect(content.style.transform).toBe("matrix(1, 0, 0, 1, 0, 0)");
    expect(state.pending().scrollTop).toBe(0);
  });

  it("moves content and ink independently when unlinked, then aligns them explicitly", () => {
    const { scene, paper, state, content } = setup();
    scene.scrollBy(100);
    scene.linkedChanged(false);
    paper.setViewport({ x: 80, y: 20, scale: 2, rotation: 0.3 });
    scene.scrollBy(100);
    expect(paper.view.getViewport()).toEqual({ x: 80, y: 20, scale: 2, rotation: 0.3 });
    expect(state.pending().content).toMatchObject({ x: 0, y: 0, scale: 1 });
    expect(content.style.transform).toBe("matrix(1, 0, 0, 1, 0, 0)");
    scene.linkedChanged(true);
    expect(paper.view.getViewport()).toMatchObject({ x: 0, y: -200, scale: 1 });
  });

  it("zooms and rotates only the reference page around the visible center when unlinked", () => {
    const { scene, paper, state, content } = setup();
    Object.defineProperty(paper.canvas, "clientWidth", { value: 600 });
    Object.defineProperty(paper.canvas, "clientHeight", { value: 400 });
    scene.scrollBy(100);
    scene.linkedChanged(false);
    const ink = paper.view.getViewport();
    const snapshot = paper.document.snapshot();
    scene.navigateContent(0, 0, 2, Math.PI / 2);
    expect(paper.view.getViewport()).toEqual(ink);
    expect(paper.document.snapshot()).toBe(snapshot);
    expect(state.pending().scrollTop).toBe(100);
    expect(state.pending().content.scale).toBe(2);
    expect(state.pending().content.rotation).toBeCloseTo(Math.PI / 2);
    expect(state.pending().content.x).toBeCloseTo(900);
    expect(state.pending().content.y).toBeCloseTo(-300);
    expect(content.style.transform).toContain(", 2, -2,");
    scene.navigateContent(80, 20);
    expect(state.pending().content.x).toBeCloseTo(980);
    expect(state.pending().content.y).toBeCloseTo(-280);
    expect(paper.view.getViewport()).toEqual(ink);
  });

  it("hides retained ink on real content reflow and resumes without requiring a signal flush", () => {
    const { scene, paper, valid, content } = setup();
    const point: PenSample = {
      x: 10,
      y: 20,
      t: 0,
      pressure: 1,
      altitude: Math.PI / 2,
      azimuth: 0,
      twist: 0,
      kind: "pen",
      width: 1,
      height: 1,
    };
    paper.document.begin("a", { tool: "draw", params: WRITE, point });
    paper.document.finish("a");
    const record = paper.document.snapshot().strokes[0];
    scene.reflow(360);
    expect(content.style.width).toBe("360px");
    expect(paper.canvas.style.visibility).toBe("hidden");
    expect(valid.get()).toBe(true);
    expect(valid.pending()).toBe(false);
    scene.resume();
    expect(paper.canvas.style.visibility).toBe("");
    expect(valid.pending()).toBe(true);
    expect(paper.document.snapshot().strokes[0]).toBe(record);
  });
});
