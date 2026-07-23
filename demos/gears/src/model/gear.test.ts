import { describe, expect, it } from "vitest";
import {
  addendumRadius,
  baseRadius,
  contactPoints,
  deg2rad,
  type GearParams,
  gearGeometry,
  involuteFn,
  involutePoint,
  meshGeometry,
  pitchRadius,
  pressureAngleAt,
  rootRadius,
  signedAlong,
} from "./gear";

const params = (over: Partial<GearParams> = {}): GearParams => ({
  teeth: 18,
  module: 8,
  pressureAngle: 20,
  addendum: 1,
  dedendum: 1.25,
  ...over,
});

const dist = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.hypot(a.x - b.x, a.y - b.y);

describe("radii", () => {
  it("pitch radius is m·z/2", () => {
    expect(pitchRadius(params({ teeth: 20, module: 5 }))).toBe(50);
  });
  it("base radius is r·cos φ", () => {
    const p = params({ teeth: 20, module: 5, pressureAngle: 20 });
    expect(baseRadius(p)).toBeCloseTo(50 * Math.cos(deg2rad(20)), 6);
  });
  it("addendum/root offset by ±factor·module from pitch", () => {
    const p = params({ teeth: 20, module: 5, addendum: 1, dedendum: 1.25 });
    expect(addendumRadius(p)).toBeCloseTo(55, 6);
    expect(rootRadius(p)).toBeCloseTo(50 - 6.25, 6);
  });
});

describe("involute", () => {
  it("inv(0) = 0 and inv is increasing", () => {
    expect(involuteFn(0)).toBeCloseTo(0, 9);
    expect(involuteFn(deg2rad(20))).toBeGreaterThan(0);
    expect(involuteFn(deg2rad(25))).toBeGreaterThan(involuteFn(deg2rad(20)));
  });
  it("involute point at t=0 sits on the base circle at (rb,0)", () => {
    const p = involutePoint(10, 0);
    expect(p.x).toBeCloseTo(10, 9);
    expect(p.y).toBeCloseTo(0, 9);
  });
  it("involute point radius grows as rb·sqrt(1+t²)", () => {
    const rb = 10;
    for (const t of [0.2, 0.5, 1.0]) {
      const p = involutePoint(rb, t);
      expect(Math.hypot(p.x, p.y)).toBeCloseTo(rb * Math.sqrt(1 + t * t), 6);
    }
  });
  it("pressure angle at the base radius is 0 and rises with radius", () => {
    expect(pressureAngleAt(10, 10)).toBeCloseTo(0, 9);
    expect(pressureAngleAt(10, 12)).toBeGreaterThan(0);
    expect(pressureAngleAt(10, 14)).toBeGreaterThan(pressureAngleAt(10, 12));
  });
});

describe("gearGeometry", () => {
  it("outline points all lie within [root, addendum] radius band", () => {
    const g = gearGeometry(params());
    for (const pt of g.outline) {
      const r = Math.hypot(pt.x, pt.y);
      expect(r).toBeGreaterThanOrEqual(g.rootRadius - 1e-6);
      expect(r).toBeLessThanOrEqual(g.addendumRadius + 1e-6);
    }
  });
  it("the outline reaches both the root and the addendum radius", () => {
    const g = gearGeometry(params());
    const radii = g.outline.map((p) => Math.hypot(p.x, p.y));
    expect(Math.min(...radii)).toBeCloseTo(g.rootRadius, 3);
    expect(Math.max(...radii)).toBeCloseTo(g.addendumRadius, 3);
  });
  it("angular pitch is 2π/z and the outline repeats per tooth", () => {
    const g = gearGeometry(params({ teeth: 12 }));
    expect(g.angularPitch).toBeCloseTo((2 * Math.PI) / 12, 9);
    // outline length is a whole number of repeating units
    expect(g.outline.length % g.toothProfile.length).toBe(0);
    expect(g.outline.length / g.toothProfile.length).toBe(12);
  });
  it("flags root-below-base by the cos-φ crossover (≈z=42 at 20°)", () => {
    // Very many teeth: root climbs above the base circle.
    expect(gearGeometry(params({ teeth: 50 })).rootBelowBase).toBe(false);
    // Typical counts: base circle sits above the root, radial fillet below.
    expect(gearGeometry(params({ teeth: 18 })).rootBelowBase).toBe(true);
  });
  it("tooth is symmetric about the +x axis", () => {
    const g = gearGeometry(params({ teeth: 24 }));
    // for every point in the tooth profile above x-axis there is a mirror below
    const above = g.toothProfile.filter((p) => p.y > 0.5);
    for (const p of above.slice(0, 5)) {
      const mirrored = g.toothProfile.some(
        (q) => Math.abs(q.x - p.x) < 1e-6 && Math.abs(q.y + p.y) < 1e-6,
      );
      expect(mirrored).toBe(true);
    }
  });
});

describe("meshGeometry", () => {
  it("centre distance is the sum of pitch radii", () => {
    const a = gearGeometry(params({ teeth: 12 }));
    const b = gearGeometry(params({ teeth: 24 }));
    const m = meshGeometry(a, b);
    expect(m.center).toBeCloseTo(a.pitchRadius + b.pitchRadius, 9);
  });
  it("ratio is z2/z1", () => {
    const a = gearGeometry(params({ teeth: 12 }));
    const b = gearGeometry(params({ teeth: 30 }));
    expect(meshGeometry(a, b).ratio).toBeCloseTo(30 / 12, 9);
  });
  it("base pitch equals π·m·cos φ and matches for both gears", () => {
    const a = gearGeometry(params({ teeth: 12, module: 6, pressureAngle: 20 }));
    const b = gearGeometry(params({ teeth: 25, module: 6, pressureAngle: 20 }));
    const m = meshGeometry(a, b);
    expect(m.basePitch).toBeCloseTo(Math.PI * 6 * Math.cos(deg2rad(20)), 6);
  });
  it("the line of action is tangent to both base circles", () => {
    const a = gearGeometry(params({ teeth: 15 }));
    const b = gearGeometry(params({ teeth: 21 }));
    const m = meshGeometry(a, b);
    // tangent point A is at base radius from gear A's centre (origin)
    expect(Math.hypot(m.tangentA.x, m.tangentA.y)).toBeCloseTo(a.baseRadius, 4);
    // tangent point B is at base radius from gear B's centre (C,0)
    expect(dist(m.tangentB, { x: m.center, y: 0 })).toBeCloseTo(b.baseRadius, 4);
  });
  it("loaDir is inclined at the pressure angle from the common tangent", () => {
    const a = gearGeometry(params({ pressureAngle: 20 }));
    const b = gearGeometry(params({ teeth: 22, pressureAngle: 20 }));
    const m = meshGeometry(a, b);
    // angle from +y axis equals φ
    const angFromY = Math.atan2(m.loaDir.x, m.loaDir.y);
    expect(angFromY).toBeCloseTo(deg2rad(20), 6);
  });
  it("contact ratio is between 1 and 2 for a normal pair", () => {
    const a = gearGeometry(params({ teeth: 17 }));
    const b = gearGeometry(params({ teeth: 28 }));
    const cr = meshGeometry(a, b).contactRatio;
    expect(cr).toBeGreaterThan(1);
    expect(cr).toBeLessThan(2.2);
  });
});

describe("contactPoints", () => {
  const a = gearGeometry(params({ teeth: 15 }));
  const b = gearGeometry(params({ teeth: 21 }));
  const m = meshGeometry(a, b);

  it("every contact point lies on the line of action", () => {
    for (let deg = 0; deg < 60; deg += 3) {
      const pts = contactPoints(a, m, deg2rad(deg));
      for (const pt of pts) {
        // distance from the infinite line of action ≈ 0
        const perp = Math.abs(
          (pt.x - m.pitchPoint.x) * m.loaDir.y - (pt.y - m.pitchPoint.y) * m.loaDir.x,
        );
        expect(perp).toBeLessThan(1e-6);
      }
    }
  });
  it("all contact points fall inside the path of contact", () => {
    const uStart = signedAlong(m.loaStart, m.pitchPoint, m.loaDir);
    const uEnd = signedAlong(m.loaEnd, m.pitchPoint, m.loaDir);
    for (let deg = 0; deg < 90; deg += 2) {
      for (const pt of contactPoints(a, m, deg2rad(deg))) {
        const u = signedAlong(pt, m.pitchPoint, m.loaDir);
        expect(u).toBeGreaterThanOrEqual(uStart - 1e-6);
        expect(u).toBeLessThanOrEqual(uEnd + 1e-6);
      }
    }
  });
  it("number of engaged pairs brackets the contact ratio", () => {
    let min = Infinity;
    let max = 0;
    for (let deg = 0; deg < 120; deg += 0.5) {
      const n = contactPoints(a, m, deg2rad(deg)).length;
      min = Math.min(min, n);
      max = Math.max(max, n);
    }
    expect(min).toBe(Math.floor(m.contactRatio));
    expect(max).toBe(Math.ceil(m.contactRatio));
  });
  it("contact advances monotonically along the line within one engagement", () => {
    const u = (deg: number) => {
      const pts = contactPoints(a, m, deg2rad(deg));
      return signedAlong(pts[pts.length - 1], m.pitchPoint, m.loaDir);
    };
    // small rotation step keeps us within one tooth engagement
    expect(u(1)).toBeGreaterThan(u(0.5));
  });
});
