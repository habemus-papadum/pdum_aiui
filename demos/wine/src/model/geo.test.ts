/**
 * geo.test.ts — the Equal-Earth math (playbook layer 1): reference values
 * from the published projection, forward/inverse round-trips, and the degree
 * box ↔ projected box transforms the map facet binding rides.
 */
import { describe, expect, it } from "vitest";
import {
  degreesToEqBox,
  EQ_X_MAX,
  EQ_Y_MAX,
  eqBoxToDegrees,
  equalEarth,
  equalEarthInverse,
} from "./geo";

describe("equalEarth", () => {
  it("matches the published reference extents", () => {
    // Šavrič–Patterson–Jenny 2018: x_max ≈ 2.7066 at (180°, 0°), aspect ≈ 2.055.
    expect(EQ_X_MAX).toBeCloseTo(2.7066, 3);
    expect((2 * EQ_X_MAX) / (2 * EQ_Y_MAX)).toBeCloseTo(2.055, 2);
    expect(equalEarth(0, 0)).toEqual({ x: 0, y: 0 });
  });

  it("inverse round-trips across the globe", () => {
    for (const [lon, lat] of [
      [4.85, 47.05], // Burgundy
      [-71.3, -34.7], // Colchagua
      [138.9, -34.6], // Barossa
      [-119.6, 36.75], // California
    ]) {
      const p = equalEarth(lon, lat);
      const back = equalEarthInverse(p.x, p.y);
      expect(back.lon).toBeCloseTo(lon, 6);
      expect(back.lat).toBeCloseTo(lat, 6);
    }
  });
});

describe("degree box ↔ projected box", () => {
  it("null pair means no box", () => {
    expect(degreesToEqBox(null, null)).toBeNull();
    expect(eqBoxToDegrees(null)).toEqual([null, null]);
  });

  it("a projected box round-trips to a bounding degree box", () => {
    const box = degreesToEqBox({ lo: -10, hi: 20 }, { lo: 35, hi: 55 });
    expect(box).not.toBeNull();
    const [lonV, latV] = eqBoxToDegrees(box);
    // The eq box BOUNDS the degree box, so the round-trip can only widen.
    expect(lonV?.lo).toBeLessThanOrEqual(-10);
    expect(lonV?.hi).toBeGreaterThanOrEqual(20);
    expect(latV?.lo).toBeCloseTo(35, 0);
    expect(latV?.hi).toBeCloseTo(55, 0);
  });

  it("an open side widens to the full extent", () => {
    const box = degreesToEqBox({ lo: 0 }, null);
    expect(box?.[1][0]).toBeCloseTo(-EQ_Y_MAX, 5);
    expect(box?.[1][1]).toBeCloseTo(EQ_Y_MAX, 5);
  });
});
