import { expect, it } from "vitest";
import {
  circlePair,
  pairFromScreen,
  pairToScreen,
  pairViewport,
  poseFromPoint,
} from "./circle-pair";

const solve = (radiusA: number, radiusB: number, distance: number, angle = 0, held = false) =>
  circlePair({ radiusA, radiusB, pose: { distance, angle }, held });

it.each([
  [115.5, "separated"],
  [115, "external-tangent"],
  [114.5, "intersecting"],
  [25, "internal-tangent"],
  [24.5, "contained"],
] as const)("classifies the authored distance %s without a pixel tolerance", (distance, relation) => {
  expect(solve(70, 45, distance).relation).toBe(relation);
});
it("distinguishes coincident boundaries from concentric containment and never invents a normal", () => {
  const same = solve(45, 45, 0);
  expect(same.relation).toBe("coincident");
  expect(same.normal).toBeNull();
  expect(same.contactPoint).toBeNull();
  const nested = solve(70, 45, 0);
  expect(nested.relation).toBe("contained");
  expect(nested.normal).toBeNull();
  expect(nested.tangent).toBeNull();
});
it("keeps exact external tangency intent while numerical witnesses rotate", () => {
  for (let angle = -180; angle < 180; angle += 7) {
    const pair = solve(70.5, 45, 200, angle, true);
    expect(pair.distance).toBe(115.5);
    expect(pair.gap).toBe(0);
    expect(pair.facingA).toEqual(pair.facingB);
    expect(pair.contactPoint).toEqual(pair.facingA);
    expect(Math.hypot(pair.centerB.x, pair.centerB.y)).toBeCloseTo(pair.distance, 10);
    expect(
      pair.normal &&
        pair.tangent &&
        pair.normal.x * pair.tangent.x + pair.normal.y * pair.tangent.y,
    ).toBeCloseTo(0, 12);
  }
});
it("constructs internal contact on the appropriate side of A", () => {
  expect(solve(70, 45, 25).contactPoint).toEqual({ x: 70, y: 0 });
  expect(solve(45, 70, 25).contactPoint?.x).toBe(-45);
});
it("intersection witnesses lie on both circles", () => {
  for (const angle of [-120, 0, 33, 90]) {
    const pair = solve(70, 45, 90, angle);
    expect(pair.crossings).toHaveLength(2);
    for (const point of pair.crossings) {
      expect(Math.hypot(point.x, point.y)).toBeCloseTo(70, 10);
      expect(Math.hypot(point.x - pair.centerB.x, point.y - pair.centerB.y)).toBeCloseTo(45, 10);
    }
  }
});
it("converts pointer coordinates to bounded polar intent, preserving the last bearing at the origin", () => {
  expect(poseFromPoint({ x: 0, y: 150 }, { distance: 170, angle: 25 }, 115, true)).toEqual({
    distance: 115,
    angle: 90,
  });
  expect(poseFromPoint({ x: 0, y: 0 }, { distance: 170, angle: 25 }, 115, false)).toEqual({
    distance: 0,
    angle: 25,
  });
  expect(poseFromPoint({ x: 500, y: 0 }, { distance: 170, angle: 25 }, 115, false).distance).toBe(
    240,
  );
  expect(() => solve(70, 45, 114.99)).toThrow();
  expect(() => solve(0, 45, 100)).toThrow();
});
it.each([320, 390, 900])("round trips screen coordinates at width %s", (width) => {
  const view = pairViewport(width);
  const point = { x: 123.5, y: -80 };
  const actual = pairFromScreen(pairToScreen(point, view), view);
  expect(actual.x).toBeCloseTo(point.x, 10);
  expect(actual.y).toBeCloseTo(point.y, 10);
});
