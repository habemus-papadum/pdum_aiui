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

function setup() {
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
    localInput: false,
    params: () => WRITE,
    onViewportChange: (viewport) => scene?.viewportChanged(viewport),
  });
  const pad = new PadRenderer();
  scene = new LabScene({ paper, pad, state, valid, linked: () => true, width: () => 640 });
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
