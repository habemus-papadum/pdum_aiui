// @vitest-environment jsdom
import { flush } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInkDocument } from "./document";
import { WRITE } from "./pencil";
import { inkSignals } from "./reactive";
import type { PenSample } from "./telemetry";

const pt = (x: number): PenSample => ({
  x,
  y: 0,
  t: x,
  pressure: 0.5,
  altitude: Math.PI / 2,
  azimuth: 0,
  twist: 0,
  kind: "pen",
  width: 1,
  height: 1,
});
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
describe("inkSignals", () => {
  it("coalesces snapshot production and publishes complete cumulative input", () => {
    const doc = createInkDocument();
    const ink = inkSignals(doc, { liveHz: 4 });
    doc.begin("s", { tool: "draw", params: WRITE, point: pt(0) });
    flush();
    const snapshot = vi.spyOn(doc, "snapshot");
    snapshot.mockClear();
    for (let i = 1; i <= 30; i++) doc.append("s", [pt(i)]);
    expect(snapshot).not.toHaveBeenCalled();
    expect(ink.live()[0].points).toHaveLength(1);
    vi.advanceTimersByTime(250);
    flush();
    expect(ink.live()[0].points).toHaveLength(31);
    expect(snapshot).toHaveBeenCalledTimes(1);
    ink.dispose();
  });
  it("commits atomically during a live throttle window, with reactive undo and erasure", () => {
    const doc = createInkDocument();
    const ink = inkSignals(doc, { liveHz: 4 });
    doc.begin("s", { tool: "draw", params: WRITE, point: pt(0) });
    doc.append("s", [pt(20)]);
    doc.finish("s");
    flush();
    expect(ink.live()).toEqual([]);
    expect(ink.strokes()).toHaveLength(1);
    const samples = ink.strokes()[0].points;
    doc.begin("eraser", { tool: "erase", params: { ...WRITE, size: 2 }, point: pt(10) });
    doc.finish("eraser");
    flush();
    expect(ink.strokes()[0].points).toBe(samples);
    expect(ink.strokes()[0].erasures).toHaveLength(1);
    doc.undo();
    flush();
    expect(ink.strokes()[0].erasures).toHaveLength(0);
    doc.redo();
    flush();
    expect(ink.strokes()[0].erasures).toHaveLength(1);
    ink.dispose();
  });
  it("cancellation immediately removes a pending live snapshot", () => {
    const doc = createInkDocument();
    const ink = inkSignals(doc);
    doc.begin("s", { tool: "draw", params: WRITE, point: pt(0) });
    doc.append("s", [pt(1)]);
    doc.cancel("s");
    flush();
    expect(ink.live()).toEqual([]);
    vi.runAllTimers();
    flush();
    expect(ink.live()).toEqual([]);
    ink.dispose();
  });
  it("adopts current state and cancels pending publication on disposal", () => {
    const doc = createInkDocument();
    doc.begin("s", { tool: "draw", params: WRITE, point: pt(0) });
    const ink = inkSignals(doc);
    flush();
    const initial = ink.snapshot();
    doc.append("s", [pt(1)]);
    ink.dispose();
    vi.runAllTimers();
    flush();
    expect(ink.snapshot()).toBe(initial);
    expect(vi.getTimerCount()).toBe(0);
  });
});
