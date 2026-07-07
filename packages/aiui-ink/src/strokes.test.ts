import { describe, expect, it } from "vitest";
import { boundsOf, pressureWidth, smoothedSegments, strokeAlpha } from "./strokes";

describe("boundsOf", () => {
  it("is an empty rect for no points", () => {
    expect(boundsOf([])).toEqual({ x: 0, y: 0, w: 0, h: 0 });
  });

  it("tightly bounds a point cloud", () => {
    expect(
      boundsOf([
        { x: 2, y: 5 },
        { x: 10, y: 1 },
        { x: 4, y: 9 },
      ]),
    ).toEqual({ x: 2, y: 1, w: 8, h: 8 });
  });
});

describe("smoothedSegments", () => {
  it("yields nothing for fewer than two points", () => {
    expect(smoothedSegments([])).toEqual([]);
    expect(smoothedSegments([{ x: 1, y: 1 }])).toEqual([]);
  });

  it("controls on samples and ends on midpoints", () => {
    const segs = smoothedSegments([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ]);
    expect(segs).toEqual([
      { cx: 0, cy: 0, x: 5, y: 0 },
      { cx: 10, cy: 0, x: 10, y: 5 },
    ]);
  });
});

describe("strokeAlpha", () => {
  it("persists when fade is disabled", () => {
    expect(strokeAlpha({ bornAt: 0, live: false }, 10_000, 0)).toBe(1);
  });

  it("never fades a live stroke", () => {
    expect(strokeAlpha({ bornAt: 0, live: true }, 10_000, 1000)).toBe(1);
  });

  it("ramps linearly and clamps to zero", () => {
    expect(strokeAlpha({ bornAt: 0, live: false }, 500, 1000)).toBeCloseTo(0.5);
    expect(strokeAlpha({ bornAt: 0, live: false }, 2000, 1000)).toBe(0);
  });
});

describe("pressureWidth", () => {
  it("returns the nominal width without pressure", () => {
    expect(pressureWidth(4, undefined)).toBe(4);
  });

  it("halves at zero pressure and is full at one", () => {
    expect(pressureWidth(4, 0)).toBe(2);
    expect(pressureWidth(4, 1)).toBe(4);
    expect(pressureWidth(4, 0.5)).toBe(3);
  });

  it("clamps out-of-range pressure", () => {
    expect(pressureWidth(4, 2)).toBe(4);
    expect(pressureWidth(4, -1)).toBe(2);
  });
});
