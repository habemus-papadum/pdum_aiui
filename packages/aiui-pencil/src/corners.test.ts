import { describe, expect, it } from "vitest";
import { detectCusps, turnAt } from "./corners";
import type { Vec } from "./geom";

const CONFIG = { window: 5, threshold: Math.PI / 3 };

/** A polyline sampled every `step` px along a straight run. */
function line(from: Vec, to: Vec, step: number): Vec[] {
  const length = Math.hypot(to.x - from.x, to.y - from.y);
  const n = Math.max(1, Math.round(length / step));
  return Array.from({ length: n + 1 }, (_, i) => ({
    x: from.x + ((to.x - from.x) * i) / n,
    y: from.y + ((to.y - from.y) * i) / n,
  }));
}

describe("turnAt", () => {
  it("is zero on a straight run", () => {
    const pts = line({ x: 0, y: 0 }, { x: 40, y: 0 }, 2);
    expect(turnAt(pts, 10, 5)).toBeCloseTo(0, 6);
  });

  it("is π/2 at a right angle", () => {
    const pts = [
      ...line({ x: 0, y: 0 }, { x: 20, y: 0 }, 2),
      ...line({ x: 20, y: 2 }, { x: 20, y: 20 }, 2),
    ];
    const corner = 10; // the point at (20, 0)
    expect(turnAt(pts, corner, 5)).toBeCloseTo(Math.PI / 2, 1);
  });

  it("is π at a full reversal", () => {
    const pts = [
      ...line({ x: 0, y: 0 }, { x: 20, y: 0 }, 2),
      ...line({ x: 18, y: 0 }, { x: 0, y: 0 }, 2),
    ];
    expect(turnAt(pts, 10, 5)).toBeGreaterThan(Math.PI * 0.9);
  });

  it("is zero at the ends — a stroke's end is not a corner", () => {
    const pts = line({ x: 0, y: 0 }, { x: 40, y: 0 }, 2);
    expect(turnAt(pts, 0, 5)).toBe(0);
    expect(turnAt(pts, pts.length - 1, 5)).toBe(0);
  });

  it("measures across ARC LENGTH, so the sample rate drops out", () => {
    // The same corner drawn slowly (dense samples) and quickly (sparse ones)
    // must read as the same corner. Measuring between adjacent samples instead
    // would make the answer depend on how fast the pen happened to be moving.
    const dense = [
      ...line({ x: 0, y: 0 }, { x: 20, y: 0 }, 1),
      ...line({ x: 20, y: 1 }, { x: 20, y: 20 }, 1),
    ];
    const sparse = [
      ...line({ x: 0, y: 0 }, { x: 20, y: 0 }, 4),
      ...line({ x: 20, y: 4 }, { x: 20, y: 20 }, 4),
    ];
    const denseTurn = turnAt(dense, 20, 6);
    const sparseTurn = turnAt(sparse, 5, 6);
    expect(Math.abs(denseTurn - sparseTurn)).toBeLessThan(0.35);
  });
});

describe("detectCusps", () => {
  it("finds nothing on a straight line", () => {
    const pts = line({ x: 0, y: 0 }, { x: 60, y: 0 }, 2);
    expect(detectCusps(pts, CONFIG).some(Boolean)).toBe(false);
  });

  it("finds nothing on a smooth circle — a fast arc is not a corner", () => {
    const pts = Array.from({ length: 80 }, (_, i) => {
      const a = (i / 80) * Math.PI * 2;
      return { x: 40 * Math.cos(a), y: 40 * Math.sin(a) };
    });
    expect(detectCusps(pts, CONFIG).some(Boolean)).toBe(false);
  });

  it("finds exactly one corner in an L", () => {
    const pts = [
      ...line({ x: 0, y: 0 }, { x: 30, y: 0 }, 1.5),
      ...line({ x: 30, y: 1.5 }, { x: 30, y: 30 }, 1.5),
    ];
    const cusps = detectCusps(pts, CONFIG);
    expect(cusps.filter(Boolean).length).toBe(1);

    // …and it must be AT the corner, not somewhere along the approach.
    const at = cusps.indexOf(true);
    expect(pts[at].x).toBeGreaterThan(26);
    expect(pts[at].y).toBeLessThan(4);
  });

  it("collapses a run of over-threshold samples into ONE corner", () => {
    // A real corner drawn at a high sample rate trips the threshold at several
    // consecutive samples. Breaking the spline at each would replace the corner
    // with a short straight chamfer — which looks like a mistake, and is one.
    const pts = [
      ...line({ x: 0, y: 0 }, { x: 30, y: 0 }, 0.5),
      ...line({ x: 30, y: 0.5 }, { x: 30, y: 30 }, 0.5),
    ];
    expect(detectCusps(pts, CONFIG).filter(Boolean).length).toBe(1);
  });

  it("finds both corners of a zigzag", () => {
    const pts = [
      ...line({ x: 0, y: 0 }, { x: 20, y: 0 }, 1),
      ...line({ x: 20, y: 1 }, { x: 20, y: 20 }, 1),
      ...line({ x: 21, y: 20 }, { x: 40, y: 20 }, 1),
    ];
    expect(detectCusps(pts, CONFIG).filter(Boolean).length).toBe(2);
  });

  it("never marks an endpoint", () => {
    const pts = line({ x: 0, y: 0 }, { x: 30, y: 30 }, 1);
    const cusps = detectCusps(pts, CONFIG);
    expect(cusps[0]).toBe(false);
    expect(cusps[cusps.length - 1]).toBe(false);
  });

  it("handles degenerate inputs", () => {
    expect(detectCusps([], CONFIG)).toEqual([]);
    expect(detectCusps([{ x: 0, y: 0 }], CONFIG)).toEqual([false]);
    expect(
      detectCusps(
        [
          { x: 0, y: 0 },
          { x: 1, y: 1 },
        ],
        CONFIG,
      ),
    ).toEqual([false, false]);
  });
});
