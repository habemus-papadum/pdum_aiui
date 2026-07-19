// @vitest-environment jsdom
/**
 * surface.test.ts — the one PencilSurface behaviour a unit test can pin without
 * a real 2-D context (jsdom's `getContext` returns null, so anything that
 * *commits* a stroke — planStroke → stampDabs → a Layer canvas — needs a
 * browser). What it CAN pin is the subtle contract of {@link
 * PencilSurface.clearCompleted}: it must not disturb a stroke still under the
 * pen. That is the whole reason the method exists (a plain `clear()` from
 * `onStrokeStart` would wipe the mark just begun, because the new stroke has
 * already joined `live` by the time the callback fires).
 */
import { afterEach, describe, expect, it } from "vitest";
import { PencilSurface, type PenSample, WRITE } from "./index";

function sample(x: number, y: number): PenSample {
  return {
    x,
    y,
    t: 0,
    pressure: 0.5,
    altitude: Math.PI / 2,
    azimuth: 0,
    twist: 0,
    kind: "pen",
    width: 1,
    height: 1,
  };
}

describe("PencilSurface.clearCompleted", () => {
  let surface: PencilSurface | undefined;
  afterEach(() => {
    surface?.dispose();
    surface = undefined;
  });

  it("leaves a stroke still under the pen untouched", () => {
    surface = new PencilSurface({ params: () => WRITE, localInput: false });
    // A stroke in flight — the exact state `onStrokeStart` sees when it would
    // call clearCompleted (the new stroke has already joined `live`).
    surface.remoteBegin("s1", { tool: "draw", params: WRITE, point: sample(10, 10) });
    surface.remotePoint("s1", sample(20, 20));
    expect(surface.ink().live.length).toBe(1);
    expect(surface.hasInk()).toBe(true);

    let strokeEvents = 0;
    const off = surface.subscribe((e) => {
      if (e === "strokes") strokeEvents += 1;
    });

    surface.clearCompleted();

    // The in-flight stroke survives — a plain clear() would have wiped it.
    expect(surface.ink().live.length).toBe(1);
    expect(surface.hasInk()).toBe(true);
    // Nothing had completed, so no "strokes" change was announced.
    expect(strokeEvents).toBe(0);
    off();
  });
});
