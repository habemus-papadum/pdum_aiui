import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInkDocument } from "./document";
import { WRITE } from "./pencil";
import { InkPresentation } from "./presentation";
import type { PenSample } from "./telemetry";

const pt: PenSample = {
  x: 10,
  y: 10,
  t: 0,
  pressure: 1,
  altitude: Math.PI / 2,
  azimuth: 0,
  twist: 0,
  kind: "pen",
  width: 1,
  height: 1,
};
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => vi.useRealTimers());
const setup = () => {
  const doc = createInkDocument({ now: () => Date.now() });
  doc.begin("old", { tool: "draw", params: WRITE, point: pt });
  doc.finish("old");
  return doc;
};
describe("InkPresentation", () => {
  it.each([
    "warp",
    "crossfade",
  ] as const)("keeps completed %s fades hidden when timing is disabled or extended", (curve) => {
    const doc = setup();
    const capture = doc.capture();
    const stroke = capture.strokes[0];
    const presentation = new InkPresentation(doc, {
      durationMs: 1000,
      curve,
      now: () => Date.now(),
    });
    // Completion is recorded without a renderer or a call to style().
    vi.advanceTimersByTime(1000);
    expect(vi.getTimerCount()).toBe(0);
    presentation.configure({ durationMs: 0 });
    expect(presentation.style(stroke).alpha).toBe(0);
    presentation.configure({ durationMs: 10000 });
    expect(presentation.style(stroke).alpha).toBe(0);
    expect(presentation.animating()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    presentation.configure({ durationMs: 0 });
    doc.begin("new", { tool: "draw", params: WRITE, point: pt });
    doc.finish("new");
    const fresh = doc.snapshot().strokes[1];
    expect(presentation.style(fresh).alpha).toBe(1);
    expect(doc.snapshot().strokes[0]).toBe(stroke);
    expect(capture.strokes[0]).toBe(stroke);
    expect(doc.canUndo).toBe(true);
    presentation.dispose();
  });
  it("accounts for completed fades before reconfiguring when timers have been delayed", () => {
    const doc = setup();
    const presentation = new InkPresentation(doc, { durationMs: 1000, now: () => Date.now() });
    // Advancing the clock alone simulates a suspended timer in a background tab.
    vi.setSystemTime(2000);
    presentation.configure({ durationMs: 0 });
    expect(presentation.style(doc.snapshot().strokes[0]).alpha).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    presentation.dispose();
  });
  it("lets timing changes affect ink whose fade has not completed", () => {
    const doc = setup();
    const stroke = doc.snapshot().strokes[0];
    const presentation = new InkPresentation(doc, {
      durationMs: 1000,
      curve: "crossfade",
      now: () => Date.now(),
    });
    vi.advanceTimersByTime(500);
    expect(presentation.style(stroke).alpha).toBe(0.5);
    presentation.configure({ durationMs: 0 });
    vi.advanceTimersByTime(2000);
    expect(presentation.style(stroke).alpha).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    presentation.configure({ durationMs: 4000 });
    vi.advanceTimersByTime(1500);
    presentation.configure({ durationMs: 0 });
    expect(presentation.style(stroke).alpha).toBe(0);
    presentation.dispose();
  });
  it("does not replay a completed exit when fading the same capture again", () => {
    const doc = setup();
    const presentation = new InkPresentation(doc, { now: () => Date.now() });
    presentation.fadeOut(doc.capture(), 100, false);
    vi.advanceTimersByTime(100);
    presentation.fadeOut(doc.capture(), 100, false);
    expect(presentation.style(doc.snapshot().strokes[0]).alpha).toBe(0);
    expect(presentation.animating()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    presentation.dispose();
  });
  it("fades visually without destroying source data or its capture", () => {
    const doc = setup(),
      capture = doc.capture();
    const presentation = new InkPresentation(doc, { durationMs: 1000, now: () => Date.now() });
    const stroke = doc.snapshot().strokes[0];
    expect(presentation.style(stroke).alpha).toBe(1);
    vi.advanceTimersByTime(900);
    expect(presentation.style(stroke).widthScale).toBeGreaterThan(1);
    vi.advanceTimersByTime(100);
    expect(presentation.style(stroke).alpha).toBe(0);
    expect(doc.snapshot().strokes[0]).toBe(stroke);
    expect(capture.strokes[0]).toBe(stroke);
    presentation.dispose();
  });
  it("explicit expiry works without a renderer and cannot resurrect through undo", () => {
    const doc = setup();
    const capture = doc.capture();
    const presentation = new InkPresentation(doc, {
      durationMs: 1000,
      expire: true,
      now: () => Date.now(),
    });
    doc.begin("live", { tool: "draw", params: WRITE, point: pt });
    vi.advanceTimersByTime(1000);
    expect(doc.snapshot().strokes).toHaveLength(0);
    expect(doc.snapshot().live).toHaveLength(1);
    expect(doc.undo()).toBe(false);
    expect(capture.strokes).toHaveLength(1);
    presentation.dispose();
  });
  it("completed ink can pop while new and live strokes survive", () => {
    const doc = setup();
    const presentation = new InkPresentation(doc, { now: () => Date.now() });
    presentation.fadeOut(doc.capture(), 500);
    doc.begin("new", { tool: "draw", params: WRITE, point: pt });
    doc.finish("new");
    doc.begin("live", { tool: "draw", params: WRITE, point: pt });
    vi.advanceTimersByTime(500);
    expect(doc.snapshot().strokes.map((s) => s.id)).toEqual(["new"]);
    expect(doc.snapshot().live[0].id).toBe("live");
    presentation.dispose();
  });
  it("a fade request does not retire edited records and timers stop at disposal", () => {
    const doc = setup();
    const presentation = new InkPresentation(doc, { now: () => Date.now() });
    presentation.fadeOut(doc.capture(), 500);
    doc.setParams(["old"], { ...WRITE, size: 5 });
    vi.advanceTimersByTime(500);
    expect(doc.snapshot().strokes).toHaveLength(1);
    presentation.configure({ durationMs: 2000, expire: true });
    presentation.dispose();
    vi.advanceTimersByTime(3000);
    expect(doc.snapshot().strokes).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("does not fade or expire matching IDs from a different document's capture", () => {
    const source = setup();
    const destination = setup();
    const presentation = new InkPresentation(destination, { now: () => Date.now() });
    presentation.fadeOut(source.capture(), 100);
    vi.advanceTimersByTime(200);
    const stroke = destination.snapshot().strokes[0];
    expect(stroke).toBeDefined();
    expect(presentation.style(stroke).alpha).toBe(1);
    presentation.dispose();
  });
});
