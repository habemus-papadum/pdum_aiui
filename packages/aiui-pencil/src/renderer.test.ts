// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createInkDocument } from "./document";
import { WRITE } from "./pencil";
import { InkPresentation } from "./presentation";
import { CanvasInkView } from "./renderer";
import type { PenSample } from "./telemetry";

const sample: PenSample = {
  x: 20,
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
const profile = { ...WRITE, grain: 0 };

function contexts() {
  const contexts = new WeakMap<HTMLCanvasElement, CanvasRenderingContext2D>();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (
    this: HTMLCanvasElement,
  ) {
    let context = contexts.get(this);
    if (!context) {
      context = {
        globalAlpha: 1,
        setTransform: vi.fn(),
        clearRect: vi.fn(),
        save: vi.fn(),
        restore: vi.fn(),
        translate: vi.fn(),
        beginPath: vi.fn(),
        moveTo: vi.fn(),
        lineTo: vi.fn(),
        arc: vi.fn(),
        closePath: vi.fn(),
        ellipse: vi.fn(),
        fill: vi.fn(),
        fillRect: vi.fn(),
        drawImage: vi.fn(),
      } as unknown as CanvasRenderingContext2D;
      contexts.set(this, context);
    }
    return context;
  });
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn(() => 1),
  );
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  return contexts;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("CanvasInkView data and presentation boundaries", () => {
  it("reuses computed geometry across view, placement, and partial erasure changes", () => {
    contexts();
    const ink = createInkDocument();
    ink.begin("a", { tool: "draw", params: profile, point: sample });
    ink.finish("a", { ...sample, x: 80, t: 10 });
    const view = new CanvasInkView({ document: ink, target: document.body });
    Object.defineProperty(view.canvas, "clientWidth", { value: 200 });
    Object.defineProperty(view.canvas, "clientHeight", { value: 200 });
    view.render();
    expect(view.report().computations).toBe(1);
    view.setViewport({ x: 10, y: 10, scale: 2 });
    ink.setTransform(["a"], { x: 5, y: 5, scale: 1 });
    view.render();
    expect(view.report().computations).toBe(1);
    ink.begin("erase", { tool: "erase", params: profile, point: { ...sample, x: 50, y: 25 } });
    view.render();
    ink.finish("erase");
    view.render();
    expect(ink.snapshot().strokes[0].erasures).toHaveLength(1);
    expect(view.report().computations).toBe(1);
    view.evictCache();
    view.render();
    expect(view.report().computations).toBe(1);
    ink.setParams(["a"], { ...profile, size: 5 });
    view.render();
    expect(view.report().computations).toBe(2);
    view.dispose();
  });

  it("paints a rotated viewport, clips all inverse corners, and reuses geometry after returning onscreen", () => {
    const canvases = contexts();
    const ink = createInkDocument();
    ink.begin("a", { tool: "draw", params: profile, point: sample });
    ink.finish("a", { ...sample, x: 80, t: 10 });
    const record = ink.snapshot().strokes[0];
    const viewport = { x: 100, y: 0, scale: 1, rotation: Math.PI / 2 };
    const view = new CanvasInkView({ document: ink, target: document.body, viewport });
    Object.defineProperty(view.canvas, "clientWidth", { value: 100 });
    Object.defineProperty(view.canvas, "clientHeight", { value: 100 });
    view.render();
    const context = canvases.get(view.canvas);
    if (!context) throw new Error("Missing view context");
    expect(context.drawImage).toHaveBeenCalledTimes(1);
    const matrix = vi.mocked(context.setTransform).mock.calls.at(-1);
    expect(matrix?.[0]).toBeCloseTo(0, 10);
    expect(matrix?.[1]).toBeCloseTo(1, 10);
    expect(matrix?.[2]).toBeCloseTo(-1, 10);
    expect(matrix?.[3]).toBeCloseTo(0, 10);
    expect(matrix?.slice(4)).toEqual([100, 0]);
    const capture = view.renderCapture(ink.capture(), 100, 100);
    expect(canvases.get(capture)?.drawImage).toHaveBeenCalledTimes(1);
    view.setViewport({ ...viewport, x: -1000, y: -1000 });
    view.render();
    expect(context.drawImage).toHaveBeenCalledTimes(1);
    view.evictCache();
    view.setViewport(viewport);
    view.render();
    expect(context.drawImage).toHaveBeenCalledTimes(2);
    expect(view.report().computations).toBe(1);
    expect(ink.snapshot().strokes[0]).toBe(record);
    view.dispose();
  });

  it("does not restart a submitted stroke's fade while previewing an eraser", () => {
    const canvases = contexts();
    let now = 0;
    const ink = createInkDocument({ now: () => now });
    ink.begin("a", { tool: "draw", params: profile, point: sample });
    ink.finish("a", { ...sample, x: 80, t: 10 });
    const presentation = new InkPresentation(ink, { now: () => now });
    presentation.fadeOut(ink.capture(), 500, false);
    const view = new CanvasInkView({ document: ink, target: document.body, presentation });
    Object.defineProperty(view.canvas, "clientWidth", { value: 100 });
    Object.defineProperty(view.canvas, "clientHeight", { value: 100 });
    now = 450;
    ink.begin("erase", { tool: "erase", params: profile, point: { ...sample, x: 50 } });
    view.render();
    const expected = presentation.style(ink.snapshot().strokes[0], now);
    expect(expected.alpha).toBeLessThan(1);
    expect(canvases.get(view.canvas)?.globalAlpha).toBe(expected.alpha);
    expect(ink.snapshot().strokes[0].erasures).toHaveLength(0);
    ink.cancel("erase");
    view.dispose();
    presentation.dispose();
  });
  it("releases a temporary capture view when rendering fails", () => {
    contexts();
    const ink = createInkDocument();
    const subscribe = ink.subscribe.bind(ink);
    let activeSubscriptions = 0;
    vi.spyOn(ink, "subscribe").mockImplementation((listener) => {
      activeSubscriptions++;
      const unsubscribe = subscribe(listener);
      return () => {
        activeSubscriptions--;
        unsubscribe();
      };
    });
    const view = new CanvasInkView({
      document: ink,
      target: document.body,
      background: () => {
        throw new Error("Background failed");
      },
    });
    expect(activeSubscriptions).toBe(1);
    expect(() => view.renderCapture(ink.capture(), 100, 100)).toThrow("Background failed");
    expect(activeSubscriptions).toBe(1);
    view.dispose();
    expect(activeSubscriptions).toBe(0);
  });
});
