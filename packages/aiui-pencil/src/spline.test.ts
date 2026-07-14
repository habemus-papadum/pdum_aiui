import { describe, expect, it } from "vitest";
import { blendSample, catmullRom, densify } from "./spline";
import type { PenSample } from "./telemetry";

function sample(x: number, y: number, extra: Partial<PenSample> = {}): PenSample {
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
    ...extra,
  };
}

describe("catmullRom", () => {
  it("passes through its control points — the pen went where it went", () => {
    // The defining property, and the reason this is Catmull-Rom rather than the
    // Bézier-through-midpoints scheme the old ink surface uses: a curve that
    // merely APPROACHES the samples has quietly moved the user's line.
    const p0 = { x: 0, y: 0 };
    const p1 = { x: 10, y: 0 };
    const p2 = { x: 20, y: 10 };
    const p3 = { x: 30, y: 10 };
    const start = catmullRom(p0, p1, p2, p3, 0);
    const end = catmullRom(p0, p1, p2, p3, 1);
    expect(start.x).toBeCloseTo(p1.x, 8);
    expect(start.y).toBeCloseTo(p1.y, 8);
    expect(end.x).toBeCloseTo(p2.x, 8);
    expect(end.y).toBeCloseTo(p2.y, 8);
  });

  it("does not overshoot on unevenly spaced samples — the centripetal payoff", () => {
    // Uniform Catmull-Rom (α=0) famously loops or bulges when consecutive samples
    // are unevenly spaced — which is to say, whenever the pen changes speed,
    // which is to say, constantly. Centripetal (α=0.5) is provably free of it.
    // Here p1→p2 is short while its neighbours are long: the classic trigger.
    const p0 = { x: 0, y: 0 };
    const p1 = { x: 100, y: 0 };
    const p2 = { x: 102, y: 0 };
    const p3 = { x: 202, y: 0 };
    for (let i = 0; i <= 20; i++) {
      const p = catmullRom(p0, p1, p2, p3, i / 20, 0.5);
      // Must stay within the p1..p2 span (plus a hair) — no loop, no bulge.
      expect(p.x).toBeGreaterThanOrEqual(p1.x - 0.5);
      expect(p.x).toBeLessThanOrEqual(p2.x + 0.5);
    }
  });

  it("survives coincident samples instead of dividing by a zero knot span", () => {
    const p = { x: 5, y: 5 };
    const out = catmullRom(p, p, p, p, 0.5);
    expect(Number.isFinite(out.x)).toBe(true);
    expect(Number.isFinite(out.y)).toBe(true);
  });
});

describe("blendSample", () => {
  it("interpolates every field, and azimuth the short way", () => {
    const a = sample(0, 0, { azimuth: 6.2, pressure: 0, t: 0 });
    const b = sample(10, 0, { azimuth: 0.1, pressure: 1, t: 100 });
    const mid = blendSample(a, b, 0.5);
    expect(mid.x).toBeCloseTo(5, 8);
    expect(mid.pressure).toBeCloseTo(0.5, 8);
    expect(mid.t).toBeCloseTo(50, 8);
    // Short way across the seam, NOT back through π.
    expect(mid.azimuth < 0.1 || mid.azimuth > 6.2).toBe(true);
  });
});

describe("densify", () => {
  const config = { maxStep: 2 };

  it("passes the original samples through", () => {
    const pts = [sample(0, 0), sample(20, 0), sample(40, 20)];
    const out = densify(pts, [false, false, false], config);
    for (const original of pts) {
      expect(
        out.some((p) => Math.abs(p.x - original.x) < 1e-6 && Math.abs(p.y - original.y) < 1e-6),
      ).toBe(true);
    }
  });

  it("adds points — that is the job", () => {
    const pts = [sample(0, 0), sample(20, 0), sample(40, 20), sample(60, 20)];
    const out = densify(
      pts,
      pts.map(() => false),
      config,
    );
    expect(out.length).toBeGreaterThan(pts.length);
  });

  it("keeps a marked corner SHARP instead of rounding it off", () => {
    // The whole reason corners.ts exists. An L with the corner marked must come
    // out of the spline with the corner still there — the densified path must
    // pass exactly through it, and must not bow around the outside of it.
    const pts = [sample(0, 0), sample(10, 0), sample(20, 0), sample(20, 10), sample(20, 20)];
    const cusps = [false, false, true, false, false];
    const out = densify(pts, cusps, config);

    const exact = out.find((p) => Math.abs(p.x - 20) < 1e-9 && Math.abs(p.y - 0) < 1e-9);
    expect(exact).toBeDefined();

    // No point may stray past the corner (x > 20): a smoothed-through corner
    // bulges outward, and that bulge is precisely what turns a `k` into an `l`.
    for (const p of out) {
      expect(p.x).toBeLessThanOrEqual(20 + 1e-6);
    }
  });

  it("rounds an UNmarked corner — proving the sharpness above is deliberate", () => {
    const pts = [sample(0, 0), sample(10, 0), sample(20, 0), sample(20, 10), sample(20, 20)];
    const out = densify(
      pts,
      pts.map(() => false),
      config,
    );

    // With no cusp declared the spline carries a continuous tangent through the
    // elbow, so it bows OUTSIDE it: past x=20 on the way out, and below y=0 on
    // the way in. (Measured: 20.72 and -0.72.) That overshoot is exactly the
    // artifact the cusp break above eliminates — same five points, same code,
    // one boolean.
    expect(Math.max(...out.map((p) => p.x))).toBeGreaterThan(20 + 0.1);
    expect(Math.min(...out.map((p) => p.y))).toBeLessThan(-0.1);
  });

  it("carries pen telemetry onto the invented points", () => {
    const pts = [sample(0, 0, { pressure: 0 }), sample(20, 0, { pressure: 1 })];
    const out = densify(pts, [false, false], config);
    const mid = out[Math.floor(out.length / 2)];
    expect(mid.pressure).toBeGreaterThan(0);
    expect(mid.pressure).toBeLessThan(1);
  });

  it("passes short inputs straight through", () => {
    expect(densify([], [], config)).toEqual([]);
    const one = [sample(1, 2)];
    expect(densify(one, [false], config)).toEqual(one);
  });
});
