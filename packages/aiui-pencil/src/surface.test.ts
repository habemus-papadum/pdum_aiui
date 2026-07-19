// @vitest-environment jsdom
/**
 * surface.test.ts — the one PencilSurface behaviour a unit test can pin without
 * a real 2-D context (jsdom's `getContext` returns null, so anything that
 * *commits* a stroke — planStroke → stampDabs → a Layer canvas — needs a
 * browser). What it CAN pin is the subtle contract of {@link
 * PencilSurface.popCompleted}: it must not disturb a stroke still under the pen.
 * That is the whole reason the method exists (a plain `clearAnimated()` from
 * `onStrokeStart` would wipe the mark just begun, because the new stroke has
 * already joined `live` by the time the callback fires). The pop RE-TIMING
 * itself (advancing a completed stroke into the fade tail) needs a retained
 * stroke, which needs a commit, which needs a canvas — so it is exercised by
 * hand in the browser, not here.
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

describe("PencilSurface.popCompleted", () => {
  let surface: PencilSurface | undefined;
  afterEach(() => {
    surface?.dispose();
    surface = undefined;
  });

  function withLiveStroke(fadeSec?: () => number): PencilSurface {
    const s = new PencilSurface({ params: () => WRITE, localInput: false, fadeSec });
    // A stroke in flight — the exact state `onStrokeStart` sees when it calls
    // popCompleted (the new stroke has already joined `live`).
    s.remoteBegin("s1", { tool: "draw", params: WRITE, point: sample(10, 10) });
    s.remotePoint("s1", sample(20, 20));
    return s;
  }

  it("leaves a stroke still under the pen untouched (fade active)", () => {
    surface = withLiveStroke(() => 2.5);
    expect(surface.ink().live.length).toBe(1);

    surface.popCompleted();

    // The in-flight stroke survives — a plain clearAnimated() would have wiped it.
    expect(surface.ink().live.length).toBe(1);
    expect(surface.hasInk()).toBe(true);
  });

  it("leaves the live stroke untouched with no fade window (instant-drop branch)", () => {
    surface = withLiveStroke(); // fadeSec undefined → fadeMs 0 → drop branch
    let strokeEvents = 0;
    const off = surface.subscribe((e) => {
      if (e === "strokes") strokeEvents += 1;
    });

    surface.popCompleted();

    expect(surface.ink().live.length).toBe(1);
    expect(surface.hasInk()).toBe(true);
    // Nothing had completed, so no "strokes" change was announced.
    expect(strokeEvents).toBe(0);
    off();
  });
});
