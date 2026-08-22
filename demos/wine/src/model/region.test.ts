/**
 * region.test.ts — the pure region transforms (playbook layer 1): dims ↔
 * Rectangle round-trips, open sides widening to the projection extent, and
 * lasso polygons mirroring as bounding boxes.
 */
import { describe, expect, it } from "vitest";
import { dimsToRect, rectToDims, setProjExtent } from "./region";

describe("dimsToRect", () => {
  it("maps a full pair to the rectangle", () => {
    expect(dimsToRect({ lo: 1, hi: 2 }, { lo: 3, hi: 4 })).toEqual({
      xMin: 1,
      xMax: 2,
      yMin: 3,
      yMax: 4,
    });
  });

  it("null pair means no region", () => {
    expect(dimsToRect(null, null)).toBeNull();
  });

  it("an open side widens to the projection extent", () => {
    setProjExtent({ xMin: -10, xMax: 10, yMin: -5, yMax: 5 });
    expect(dimsToRect({ lo: 2 }, null)).toEqual({ xMin: 2, xMax: 10, yMin: -5, yMax: 5 });
  });
});

describe("rectToDims", () => {
  it("maps a rectangle exactly (rounded to 3 decimals)", () => {
    expect(rectToDims({ xMin: 0.12345, xMax: 1, yMin: -2, yMax: 3 })).toEqual([
      { lo: 0.123, hi: 1 },
      { lo: -2, hi: 3 },
    ]);
  });

  it("maps a lasso polygon to its bounding box", () => {
    const polygon = [
      { x: 1, y: 5 },
      { x: 4, y: 2 },
      { x: 2.5, y: 7 },
    ];
    expect(rectToDims(polygon)).toEqual([
      { lo: 1, hi: 4 },
      { lo: 2, hi: 7 },
    ]);
  });

  it("null and empty polygons clear both dims", () => {
    expect(rectToDims(null)).toEqual([null, null]);
    expect(rectToDims([])).toEqual([null, null]);
  });

  it("round-trips a rectangle through the dims", () => {
    const [a, b] = rectToDims({ xMin: 1, xMax: 2, yMin: 3, yMax: 4 });
    expect(dimsToRect(a, b)).toEqual({ xMin: 1, xMax: 2, yMin: 3, yMax: 4 });
  });
});
