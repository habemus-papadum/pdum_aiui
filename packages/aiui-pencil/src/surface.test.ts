// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyTransform } from "./geometry";
import { WRITE } from "./pencil";
import { PencilSurface, type PencilSurfaceOptions } from "./surface";
import type { PenSample } from "./telemetry";

const pt: PenSample = {
  x: 1,
  y: 1,
  t: 0,
  pressure: 1,
  altitude: Math.PI / 2,
  azimuth: 0,
  twist: 0,
  kind: "pen",
  width: 1,
  height: 1,
};
const papers: PencilSurface[] = [];
afterEach(() => {
  for (const paper of papers.splice(0)) paper.dispose();
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.body.replaceChildren();
});

function interactive(options: Partial<PencilSurfaceOptions> = {}) {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  const paper = new PencilSurface({ params: () => WRITE, ...options });
  papers.push(paper);
  paper.setActive(true);
  const send = (
    type: "pointerdown" | "pointermove" | "pointerup",
    kind: "pen" | "touch",
    id: number,
    x: number,
    y: number,
  ) => {
    const event = new PointerEvent(type, {
      pointerId: id,
      pointerType: kind,
      button: 0,
      clientX: x,
      clientY: y,
      width: 10,
      height: 10,
      pressure: 0.5,
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperties(event, {
      altitudeAngle: { value: Math.PI / 4 },
      azimuthAngle: { value: Math.PI / 3 },
    });
    paper.canvas.dispatchEvent(event);
  };
  return { paper, send };
}

describe("PencilSurface navigation", () => {
  it("defaults to pan, pinch and rotate after pen mode activates, with continuous gesture ownership", () => {
    const changed = vi.fn();
    const { paper, send } = interactive({ onViewportChange: changed });
    send("pointerdown", "touch", 1, 40, 40);
    send("pointerdown", "touch", 2, 60, 40);
    send("pointermove", "touch", 2, 80, 40);
    expect(paper.view.getViewport()).toEqual({ x: 0, y: 0, scale: 1 });
    send("pointerup", "touch", 1, 40, 40);
    send("pointerup", "touch", 2, 80, 40);
    send("pointerdown", "pen", 9, 10, 10);
    send("pointerup", "pen", 9, 10, 10);
    send("pointerdown", "touch", 1, 40, 40);
    send("pointerdown", "touch", 2, 60, 40);
    send("pointermove", "touch", 2, 80, 40);
    expect(paper.view.getViewport()).toEqual({ x: -40, y: -40, scale: 2, rotation: 0 });
    send("pointermove", "touch", 2, 40, 60);
    const viewport = paper.view.getViewport();
    expect(viewport.scale).toBeCloseTo(1);
    expect(viewport.rotation).toBeCloseTo(Math.PI / 2);
    const stationary = applyTransform({ x: 40, y: 40 }, viewport);
    expect(stationary.x).toBeCloseTo(40);
    expect(stationary.y).toBeCloseTo(40);
    expect(changed).toHaveBeenCalledTimes(2);
    expect(changed.mock.calls.every(([, reason]) => reason === "gesture")).toBe(true);
    expect(paper.document.snapshot().strokes).toHaveLength(1);
    expect(paper.document.snapshot().live).toHaveLength(0);
  });

  it("supports live pan, zoom and rotation switches without replaying suppressed motion", () => {
    let navigationEnabled = true;
    let pan = true;
    let zoom = false;
    let rotate = false;
    const { paper, send } = interactive({
      inputOptions: { penEnabled: true },
      navigation: {
        enabled: () => navigationEnabled,
        pan: () => pan,
        zoom: () => zoom,
        rotate: () => rotate,
      },
    });
    send("pointerdown", "touch", 1, 40, 40);
    send("pointerdown", "touch", 2, 60, 40);
    send("pointermove", "touch", 2, 80, 40);
    expect(paper.view.getViewport()).toEqual({ x: 10, y: 0, scale: 1, rotation: 0 });
    navigationEnabled = false;
    send("pointermove", "touch", 2, 100, 40);
    expect(paper.view.getViewport()).toEqual({ x: 10, y: 0, scale: 1, rotation: 0 });
    navigationEnabled = true;
    send("pointermove", "touch", 2, 120, 40);
    expect(paper.view.getViewport()).toEqual({ x: 20, y: 0, scale: 1, rotation: 0 });
    pan = false;
    zoom = true;
    rotate = true;
    send("pointermove", "touch", 2, 40, 120);
    const viewport = paper.view.getViewport();
    expect(viewport.scale).toBeCloseTo(1);
    expect(viewport.rotation).toBeCloseTo(Math.PI / 2);
    // Pan is disabled: the previous centroid remains the rotation pivot.
    expect(applyTransform({ x: 60, y: 40 }, viewport)).toEqual({ x: 80, y: 40 });
  });

  it("clamps zoom while keeping its focal point, and can disable all navigation", () => {
    const changed = vi.fn();
    const { paper, send } = interactive({
      inputOptions: { penEnabled: true },
      navigation: { pan: false, rotate: false, minScale: 0.5, maxScale: 2 },
      onViewportChange: changed,
    });
    send("pointerdown", "touch", 1, 40, 40);
    send("pointerdown", "touch", 2, 60, 40);
    send("pointermove", "touch", 2, 240, 40);
    expect(paper.view.getViewport()).toEqual({ x: -50, y: -40, scale: 2, rotation: 0 });
    send("pointermove", "touch", 2, 440, 40);
    expect(paper.view.getViewport()).toEqual({ x: -50, y: -40, scale: 2, rotation: 0 });
    expect(changed).toHaveBeenCalledTimes(1);
    send("pointermove", "touch", 2, 41, 40);
    expect(paper.view.getViewport().scale).toBe(0.5);
    const disabled = interactive({ inputOptions: { penEnabled: true }, navigation: false });
    disabled.send("pointerdown", "touch", 1, 40, 40);
    disabled.send("pointerdown", "touch", 2, 60, 40);
    disabled.send("pointermove", "touch", 2, 80, 60);
    expect(disabled.paper.view.getViewport()).toEqual({ x: 0, y: 0, scale: 1 });
  });

  it("cancels input for external viewport changes but preserves completed ink", () => {
    const changed = vi.fn();
    const { paper, send } = interactive({
      inputOptions: { penEnabled: true },
      onViewportChange: changed,
    });
    send("pointerdown", "pen", 9, 10, 10);
    paper.setViewport({ x: 20, y: 30, scale: 2, rotation: Math.PI / 2 });
    expect(paper.document.snapshot().live).toHaveLength(0);
    send("pointerup", "pen", 9, 10, 10);
    expect(paper.document.snapshot().strokes).toHaveLength(0);
    expect(changed).toHaveBeenLastCalledWith(
      { x: 20, y: 30, scale: 2, rotation: Math.PI / 2 },
      "external",
    );
    send("pointerdown", "touch", 1, 40, 40);
    send("pointerdown", "touch", 2, 60, 40);
    send("pointermove", "touch", 2, 80, 40);
    paper.setViewport({ x: 0, y: 0, scale: 1 });
    send("pointermove", "touch", 2, 100, 40);
    expect(paper.view.getViewport()).toEqual({ x: 0, y: 0, scale: 1 });
  });

  it("captures position and pen lean in rotated ink coordinates", () => {
    const { paper, send } = interactive();
    paper.setViewport({ x: 100, y: 50, scale: 2, rotation: Math.PI / 2 });
    send("pointerdown", "pen", 1, 60, 70);
    send("pointerup", "pen", 1, 60, 90);
    const stroke = paper.document.snapshot().strokes[0];
    expect(stroke.points[0].x).toBeCloseTo(10);
    expect(stroke.points[0].y).toBeCloseTo(20);
    expect(stroke.points[0].azimuth).toBeCloseTo((11 * Math.PI) / 6);
    expect(stroke.points[0].altitude).toBeCloseTo(Math.PI / 4);
    expect(stroke.points.at(-1)?.x).toBeCloseTo(20);
    expect(stroke.points.at(-1)?.y).toBeCloseTo(20);
    paper.setViewport({ x: 0, y: 0, scale: 1 });
    expect(paper.document.snapshot().strokes[0]).toBe(stroke);
  });
});
describe("PencilSurface composition", () => {
  it("editing and cancellation work without a Canvas context", () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const starts = vi.fn(),
      ends = vi.fn(),
      cancel = vi.fn();
    const paper = new PencilSurface({
      localInput: false,
      params: () => WRITE,
      onStrokeStart: starts,
      onStrokeEnd: ends,
      onStrokeCancel: cancel,
    });
    paper.document.begin("s", { tool: "draw", params: WRITE, point: pt });
    paper.document.finish("s");
    expect(starts).toHaveBeenCalledTimes(1);
    expect(ends).toHaveBeenCalledTimes(1);
    paper.document.begin("e", { tool: "erase", params: WRITE, point: pt });
    paper.document.finish("e");
    expect(ends).toHaveBeenCalledTimes(1);
    paper.document.begin("draft", { tool: "draw", params: WRITE, point: pt });
    paper.document.cancel("draft");
    expect(cancel).toHaveBeenCalledWith("draft");
    const record = paper.document.snapshot().strokes[0];
    paper.setViewport({ x: 10, y: 20, scale: 2 });
    expect(paper.document.snapshot().strokes[0]).toBe(record);
    paper.view.evictCache();
    expect(paper.document.undo()).toBe(true);
    paper.dispose();
    expect(paper.document.snapshot().strokes).toHaveLength(1);
  });
  it("releases view and expiry resources when an application cancellation callback throws", () => {
    vi.useFakeTimers();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const onCancel = vi.fn(() => {
      throw new Error("Application callback failed");
    });
    const paper = new PencilSurface({
      params: () => WRITE,
      onStrokeCancel: onCancel,
      fadeSec: () => 1,
      expireFadedInk: true,
    });
    paper.document.begin("completed", { tool: "draw", params: WRITE, point: pt });
    paper.document.finish("completed");
    paper.canvas.dispatchEvent(
      new PointerEvent("pointerdown", {
        pointerId: 1,
        pointerType: "pen",
        button: 0,
        pressure: 0.5,
        clientX: 10,
        clientY: 10,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(paper.document.snapshot().live).toHaveLength(1);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    expect(() => paper.dispose()).toThrow("subscribers failed");
    expect(paper.document.snapshot().live).toHaveLength(0);
    expect(paper.canvas.isConnected).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    paper.document.begin("external", { tool: "draw", params: WRITE, point: pt });
    expect(() => paper.document.cancel("external")).not.toThrow();
    expect(onCancel).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2000);
    expect(paper.document.snapshot().strokes).toHaveLength(1);
  });
});
