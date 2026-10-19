import { describe, expect, it } from "vitest";
import {
  circleLineContact,
  contactFromScreen,
  contactToScreen,
  contactViewport,
  movePosition,
} from "./contact";

describe("restricted circle-line geometry", () => {
  it.each([
    [60.5, "separated", 0.5],
    [60, "tangent", 0],
    [59.5, "crossing", -0.5],
  ] as const)("classifies height %s without a contact tolerance", (height, state, gap) => {
    const result = circleLineContact({ position: { x: 20, y: height }, radius: 60, locked: false });
    expect(result).toMatchObject({ state, gap, lowest: { x: 20, y: gap }, foot: { x: 20, y: 0 } });
    expect(result.normal.x * result.tangent.x + result.normal.y * result.tangent.y).toBe(0);
  });
  it("constructs exact tangency for every supported radius and preserves horizontal movement", () => {
    for (let radius = 20; radius <= 100; radius += 0.5) {
      const result = circleLineContact({ position: { x: -73.5, y: 220 }, radius, locked: true });
      expect(result.gap).toBe(0);
      expect(result.lowest).toEqual(result.foot);
      expect(result.center).toEqual({ x: -73.5, y: radius });
    }
    expect(movePosition({ x: 90.2, y: 200 }, 60, true)).toEqual({ x: 90, y: 60 });
  });
  it("limits pointer proposals to the declared domain and rejects unsupported model inputs", () => {
    expect(movePosition({ x: 900, y: -10 }, 60, false)).toEqual({ x: 180, y: 0 });
    expect(() =>
      circleLineContact({ position: { x: 0, y: 60.01 }, radius: 60, locked: false }),
    ).toThrow();
    for (const radius of [NaN, Infinity, -1, 0, 101])
      expect(() =>
        circleLineContact({ position: { x: 0, y: 80 }, radius, locked: false }),
      ).toThrow();
  });
  it.each([320, 390, 900])("maps screen input back into the same model at width %s", (width) => {
    const view = contactViewport(width);
    for (const point of [
      { x: -180, y: 0 },
      { x: 90.5, y: 60 },
      { x: 180, y: 220 },
    ]) {
      const back = contactFromScreen(contactToScreen(point, view), view);
      expect(back.x).toBeCloseTo(point.x, 10);
      expect(back.y).toBeCloseTo(point.y, 10);
    }
  });
});
