import { describe, expect, it } from "vitest";
import type { Dab } from "./dabs";
import {
  applyNavigationTransform,
  applyTransform,
  clientToInk,
  composeTransforms,
  coverageContainsPoint,
  dabContainsPoint,
  distanceToPath,
  distanceToSegment,
  hitVisibleStroke,
  inkToClient,
  invertTransform,
  transformRectBounds,
  visibleStrokeContainsPoint,
} from "./geometry";

const dab: Dab = { x: 0, y: 0, rx: 10, ry: 4, angle: 0, alpha: 1 };
const disk = (x: number, y: number, radius: number) => ({ points: [{ x, y, radius }] });

describe("uniform coordinate transforms", () => {
  it("round trips client coordinates through surface origin, pan and zoom without scaling telemetry", () => {
    const viewport = { x: -20, y: 40, scale: 2.5 };
    const origin = { x: 100, y: 200 };
    const point = { x: 310, y: 440, width: 6, height: 8, pressure: 0.7 };
    const ink = clientToInk(point, viewport, origin);
    expect(ink).toEqual({ x: 92, y: 80, width: 6, height: 8, pressure: 0.7 });
    expect(inkToClient(ink, viewport, origin)).toEqual(point);
    expect(point.x).toBe(310);
  });

  it("composes stroke placement and view mappings in application order", () => {
    const placement = { x: 12, y: -4, scale: 3 };
    const view = { x: 30, y: 20, scale: 0.5 };
    const point = { x: 3, y: 8 };
    expect(applyTransform(point, composeTransforms(view, placement))).toEqual(
      applyTransform(applyTransform(point, placement), view),
    );
    const roundTrip = applyTransform(applyTransform(point, placement), invertTransform(placement));
    expect(roundTrip.x).toBeCloseTo(point.x, 12);
    expect(roundTrip.y).toBeCloseTo(point.y, 12);
  });

  it("rotates positions clockwise and round trips translation, zoom and rotation", () => {
    const transform = { x: 100, y: 200, scale: 2, rotation: Math.PI / 2 };
    const source = { x: 3, y: 4, width: 6, pressure: 0.7, azimuth: 0.4 };
    const mapped = applyTransform(source, transform);
    expect(mapped.x).toBeCloseTo(92, 12);
    expect(mapped.y).toBeCloseTo(206, 12);
    expect(mapped.width).toBe(6);
    expect(mapped.azimuth).toBe(0.4);
    const back = applyTransform(mapped, invertTransform(transform));
    expect(back.x).toBeCloseTo(source.x, 12);
    expect(back.y).toBeCloseTo(source.y, 12);
    const outer = { x: -30, y: 50, scale: 0.3, rotation: -0.7 };
    const combined = applyTransform(source, composeTransforms(outer, transform));
    const sequential = applyTransform(mapped, outer);
    expect(combined.x).toBeCloseTo(sequential.x, 12);
    expect(combined.y).toBeCloseTo(sequential.y, 12);
  });

  it("bounds every corner when a rotated view is mapped back into ink", () => {
    const bounds = transformRectBounds(
      { x: 0, y: 0, w: 100, h: 50 },
      { x: 20, y: 30, scale: 1, rotation: Math.PI / 2 },
    );
    expect(bounds.x).toBeCloseTo(-30, 12);
    expect(bounds.y).toBeCloseTo(30, 12);
    expect(bounds.w).toBeCloseTo(50, 12);
    expect(bounds.h).toBeCloseTo(100, 12);
  });

  it("preserves the navigation focal point while translating, rotating and clamping zoom", () => {
    const before = { x: -40, y: 70, scale: 1.8, rotation: 0.4 };
    const from = { x: 130, y: 90 },
      to = { x: 160, y: 120 };
    const focalInk = clientToInk(from, before);
    const after = applyNavigationTransform(
      before,
      { from, to, scale: 2, rotation: 0.7 },
      { minScale: 0.1, maxScale: 2 },
    );
    expect(after.scale).toBe(2);
    expect(after.rotation).toBeCloseTo(1.1, 12);
    const mapped = inkToClient(focalInk, after);
    expect(mapped.x).toBeCloseTo(to.x, 12);
    expect(mapped.y).toBeCloseTo(to.y, 12);
    const shrunk = applyNavigationTransform(
      after,
      { from: to, to, scale: 0.001, rotation: 0 },
      { minScale: 0.1, maxScale: 2 },
    );
    expect(shrunk.scale).toBeCloseTo(0.1, 12);
    expect(inkToClient(focalInk, shrunk).x).toBeCloseTo(to.x, 12);
    expect(inkToClient(focalInk, shrunk).y).toBeCloseTo(to.y, 12);
  });

  it("rejects zero, negative or nonfinite mappings", () => {
    for (const scale of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => invertTransform({ x: 0, y: 0, scale })).toThrow(RangeError);
    }
    expect(() => invertTransform({ x: 0, y: 0, scale: 1, rotation: Number.NaN })).toThrow(
      RangeError,
    );
    expect(() =>
      applyNavigationTransform(
        { x: 0, y: 0, scale: 1 },
        { from: { x: 0, y: 0 }, to: { x: 0, y: 0 }, scale: 1, rotation: 0 },
        { minScale: 2, maxScale: 1 },
      ),
    ).toThrow(RangeError);
  });
});

describe("path and sweep geometry", () => {
  it("handles repeated points, endpoints and empty paths", () => {
    expect(distanceToSegment({ x: 2, y: 3 }, { x: 0, y: 0 }, { x: 0, y: 0 })).toBeCloseTo(
      Math.sqrt(13),
      12,
    );
    expect(
      distanceToPath({ x: 12, y: 4 }, [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ]),
    ).toBeCloseTo(Math.sqrt(20), 12);
    expect(distanceToPath({ x: 0, y: 0 }, [])).toBe(Number.POSITIVE_INFINITY);
  });

  it("covers the full segment between sparse eraser samples, with round ends", () => {
    const sweep = {
      points: [
        { x: -20, y: 0, radius: 2 },
        { x: 20, y: 0, radius: 2 },
      ],
    };
    expect(coverageContainsPoint(sweep, { x: 0, y: 1.9 })).toBe(true);
    expect(coverageContainsPoint(sweep, { x: 21.9, y: 0 })).toBe(true);
    expect(coverageContainsPoint(sweep, { x: 0, y: 2.1 })).toBe(false);
  });

  it("interpolates changing radii, including a stationary expanding disk", () => {
    const sweep = {
      points: [
        { x: 0, y: 0, radius: 1 },
        { x: 10, y: 0, radius: 3 },
      ],
    };
    expect(coverageContainsPoint(sweep, { x: 5, y: 1.9 })).toBe(true);
    expect(coverageContainsPoint(sweep, { x: 5, y: 2.2 })).toBe(false);
    expect(
      coverageContainsPoint(
        {
          points: [
            { x: 0, y: 0, radius: 1 },
            { x: 0, y: 0, radius: 3 },
          ],
        },
        { x: 2.5, y: 0 },
      ),
    ).toBe(true);
  });
});

describe("visible stroke footprint", () => {
  it("hits an edge of a thick dab even when the centerline is untouched", () => {
    expect(hitVisibleStroke([dab], [], disk(0, 4.5, 1), 0.01)).toBe(true);
    expect(hitVisibleStroke([dab], [], disk(0, 5.5, 1), 0.01)).toBe(false);
  });

  it("honors ellipse rotation and transparent dabs", () => {
    const rotated = { ...dab, angle: Math.PI / 2 };
    expect(dabContainsPoint(rotated, { x: 0, y: 9 })).toBe(true);
    expect(dabContainsPoint(rotated, { x: 9, y: 0 })).toBe(false);
    expect(hitVisibleStroke([rotated], [], disk(0, 9, 0.2))).toBe(true);
    expect(hitVisibleStroke([{ ...dab, alpha: 0 }], [], disk(0, 0, 20))).toBe(false);
  });

  it("excludes a previously erased part while retaining an adjacent edge", () => {
    const erase = disk(0, 0, 3);
    expect(visibleStrokeContainsPoint([dab], [erase], { x: 0, y: 0 })).toBe(false);
    expect(visibleStrokeContainsPoint([dab], [erase], { x: 0, y: 3.5 })).toBe(true);
    expect(hitVisibleStroke([dab], [erase], disk(0, 0, 2), 0.01)).toBe(false);
    expect(hitVisibleStroke([dab], [erase], disk(0, 3.5, 0.2), 0.01)).toBe(true);
  });

  it("does not re-hit the same erased sweep or erase an entirely masked stroke", () => {
    const sweep = {
      points: [
        { x: -20, y: 0, radius: 2 },
        { x: 20, y: 0, radius: 2 },
      ],
    };
    expect(hitVisibleStroke([dab], [sweep], sweep)).toBe(false);
    expect(hitVisibleStroke([dab], [disk(0, 0, 20)], disk(0, 0, 30))).toBe(false);
  });

  it("does not inflate a changing-radius sweep to its largest radius", () => {
    const sweep = {
      points: [
        { x: 0, y: 0, radius: 1 },
        { x: 20, y: 0, radius: 6 },
      ],
    };
    const dot = { ...dab, x: 1, y: 4, rx: 0.4, ry: 0.4 };
    expect(hitVisibleStroke([dot], [], sweep, 0.01)).toBe(false);
  });

  it("detects sparse crossing erasers and keeps the approximation tolerance explicit", () => {
    const sweep = {
      points: [
        { x: 0, y: -20, radius: 0.5 },
        { x: 0, y: 20, radius: 0.5 },
      ],
    };
    expect(hitVisibleStroke([dab], [], sweep)).toBe(true);
    expect(() => hitVisibleStroke([dab], [], sweep, 0)).toThrow(RangeError);
  });
});
