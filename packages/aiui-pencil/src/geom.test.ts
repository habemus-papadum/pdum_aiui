import { describe, expect, it } from "vitest";
import {
  dist,
  lerpAngle,
  polygonArea,
  polylineLength,
  resampleByArcLength,
  type Vec,
} from "./geom";

const blend = (a: Vec, b: Vec, t: number): Vec => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
});

describe("polylineLength", () => {
  it("is zero for degenerate inputs", () => {
    expect(polylineLength([])).toBe(0);
    expect(polylineLength([{ x: 1, y: 1 }])).toBe(0);
  });

  it("sums the segments", () => {
    expect(
      polylineLength([
        { x: 0, y: 0 },
        { x: 3, y: 4 },
        { x: 3, y: 9 },
      ]),
    ).toBeCloseTo(10, 10);
  });
});

describe("lerpAngle", () => {
  it("takes the short way around, not the long way", () => {
    // The bug this prevents: a pen crossing due north, whose dab cartwheels 359°
    // the wrong way because 6.28 and 0.01 look far apart to a linear lerp.
    // Short way from 6.2 to 0.1 goes FORWARD through 2π — about 0.18 rad of
    // travel — so the midpoint lands just past the seam, not back at 3.15.
    const mid = lerpAngle(6.2, 0.1, 0.5);
    const expected = 6.2 + (0.1 + Math.PI * 2 - 6.2) / 2 - Math.PI * 2;
    expect(mid).toBeCloseTo(expected, 8);
    expect(mid).toBeLessThan(0.1); // and emphatically NOT the 3.15 a naive lerp gives
  });

  it("interpolates normally away from the seam", () => {
    expect(lerpAngle(1, 2, 0.5)).toBeCloseTo(1.5, 10);
  });

  it("always returns a normalized angle", () => {
    const a = lerpAngle(6.0, 0.5, 0.9);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(Math.PI * 2);
  });
});

describe("resampleByArcLength", () => {
  it("puts a point every `spacing` units along a straight line", () => {
    const out = resampleByArcLength(
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ],
      2,
      blend,
    );
    expect(out.map((p) => p.x)).toEqual([0, 2, 4, 6, 8, 10]);
  });

  it("carries the leftover across a segment boundary", () => {
    // Two 3-unit segments at spacing 2: dabs land at 0, 2, 4, 6 — the point at 4
    // is INSIDE the second segment, one unit past the joint. Getting this wrong
    // is how you get a visible clump of graphite at every raw sample.
    const out = resampleByArcLength(
      [
        { x: 0, y: 0 },
        { x: 3, y: 0 },
        { x: 6, y: 0 },
      ],
      2,
      blend,
    );
    expect(out.map((p) => p.x)).toEqual([0, 2, 4, 6]);
  });

  it("resamples in DISTANCE, so a fast stroke is not dotted", () => {
    // The samples are unevenly spaced in x (a pen speeding up); the output must
    // be evenly spaced regardless.
    const input = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 3, y: 0 },
      { x: 9, y: 0 },
      { x: 21, y: 0 },
    ];
    const out = resampleByArcLength(input, 3, blend);
    for (let i = 1; i < out.length; i++) {
      expect(dist(out[i - 1], out[i])).toBeCloseTo(3, 8);
    }
  });

  it("interpolates the payload, not just the position", () => {
    type P = Vec & { p: number };
    const blendP = (a: P, b: P, t: number): P => ({
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t,
      p: a.p + (b.p - a.p) * t,
    });
    const out = resampleByArcLength<P>(
      [
        { x: 0, y: 0, p: 0 },
        { x: 10, y: 0, p: 1 },
      ],
      5,
      blendP,
    );
    expect(out.map((q) => q.p)).toEqual([0, 0.5, 1]);
  });

  it("skips duplicate samples instead of dividing by zero", () => {
    const out = resampleByArcLength(
      [
        { x: 0, y: 0 },
        { x: 0, y: 0 },
        { x: 4, y: 0 },
      ],
      2,
      blend,
    );
    expect(out.map((p) => p.x)).toEqual([0, 2, 4]);
  });

  it("passes a dot through — a tap is a legitimate stroke", () => {
    expect(resampleByArcLength([{ x: 1, y: 2 }], 3, blend)).toEqual([{ x: 1, y: 2 }]);
  });
});

describe("polygonArea — what did the user just circle?", () => {
  it("measures a unit square, closing the path itself", () => {
    // Open path — no repeated first point. The formula closes it.
    const square = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ];
    expect(Math.abs(polygonArea(square))).toBe(100);
  });

  it("is signed by winding, so orientation is recoverable", () => {
    const ccw = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ];
    const cw = [...ccw].reverse();
    expect(polygonArea(ccw)).toBe(-polygonArea(cw));
  });

  it("is zero for degenerate input — a dot, a line", () => {
    expect(polygonArea([])).toBe(0);
    expect(polygonArea([{ x: 3, y: 4 }])).toBe(0);
    expect(
      polygonArea([
        { x: 0, y: 0 },
        { x: 5, y: 5 },
      ]),
    ).toBe(0);
  });

  it("approximates a circle from a sampled stroke — the real use", () => {
    // 40 samples around r=50, like a circling gesture. Shoelace over the raw
    // samples should land within a couple percent of πr².
    const pts = Array.from({ length: 40 }, (_, i) => {
      const a = (i / 40) * 2 * Math.PI;
      return { x: 50 * Math.cos(a), y: 50 * Math.sin(a) };
    });
    const area = Math.abs(polygonArea(pts));
    expect(area).toBeGreaterThan(Math.PI * 2500 * 0.98);
    expect(area).toBeLessThan(Math.PI * 2500);
  });
});
