/**
 * mixture2d.test.ts — layer-1 pins for the 2-D mixture math. Everything the
 * app claims about the domain is asserted here headlessly: ellipse↔Gaussian
 * round trips, stroke fitting recovery, sampler moments, hexbin conservation,
 * and EM's two contracts — the log-likelihood climbs monotonically, and it
 * actually recovers well-separated components.
 */
import { describe, expect, it } from "vitest";
import {
  CONTOUR_SIGMA,
  cholesky2x2,
  eigen2x2,
  ellipseFromGaussian,
  emStep2d,
  fitStrokeEllipse,
  type Gaussian2D,
  gaussianFromEllipse,
  hexbin,
  initialGuess2d,
  type Mixture2D,
  mixtureFromEllipses,
  mulberry32,
  prepareSampler,
  samplePoint,
  type Vec2,
} from "./mixture2d";

/** n points of an ellipse outline (parameter-uniform — moments are exact). */
function ellipseOutline(
  cx: number,
  cy: number,
  a: number,
  b: number,
  angle: number,
  n = 200,
): Vec2[] {
  const ca = Math.cos(angle);
  const sa = Math.sin(angle);
  const out: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const t = (2 * Math.PI * i) / n;
    const ex = a * Math.cos(t);
    const ey = b * Math.sin(t);
    out.push({ x: cx + ex * ca - ey * sa, y: cy + ex * sa + ey * ca });
  }
  return out;
}

/** Interleaved-xy draws from a mixture. */
function draws(mix: Mixture2D, n: number, seed = 7): Float64Array {
  const rand = mulberry32(seed);
  const sampler = prepareSampler(mix);
  const data = new Float64Array(2 * n);
  for (let i = 0; i < n; i++) {
    const p = samplePoint(mix, sampler, rand);
    data[2 * i] = p.x;
    data[2 * i + 1] = p.y;
  }
  return data;
}

const fold = (rad: number): number => {
  let a = rad % Math.PI;
  if (a > Math.PI / 2) a -= Math.PI;
  if (a <= -Math.PI / 2) a += Math.PI;
  return a;
};

describe("eigen2x2", () => {
  it("recovers eigenvalues and axis of a rotated diagonal matrix", () => {
    // R diag(9, 4) Rᵀ at 30°
    const th = Math.PI / 6;
    const c = Math.cos(th);
    const s = Math.sin(th);
    const sxx = 9 * c * c + 4 * s * s;
    const sxy = (9 - 4) * c * s;
    const syy = 9 * s * s + 4 * c * c;
    const e = eigen2x2(sxx, sxy, syy);
    expect(e.l1).toBeCloseTo(9, 10);
    expect(e.l2).toBeCloseTo(4, 10);
    expect(fold(e.angle - th)).toBeCloseTo(0, 10);
  });
});

describe("ellipse ↔ gaussian", () => {
  it("round-trips through the contour convention", () => {
    const g = gaussianFromEllipse({ cx: 100, cy: 200, a: 80, b: 30, angle: 0.7 });
    const e = ellipseFromGaussian(g);
    expect(e.cx).toBeCloseTo(100, 8);
    expect(e.cy).toBeCloseTo(200, 8);
    expect(e.a).toBeCloseTo(80, 8);
    expect(e.b).toBeCloseTo(30, 8);
    expect(fold(e.angle - 0.7)).toBeCloseTo(0, 8);
  });

  it("floors degenerate axes into a proper covariance", () => {
    const g = gaussianFromEllipse({ cx: 0, cy: 0, a: 50, b: 0, angle: 0 });
    expect(g.syy).toBeGreaterThan(0);
    expect(g.sxx * g.syy - g.sxy * g.sxy).toBeGreaterThan(0);
  });
});

describe("fitStrokeEllipse", () => {
  it("recovers a clean outline exactly", () => {
    const e = fitStrokeEllipse(ellipseOutline(340, 220, 120, 50, 0.5));
    expect(e).not.toBeNull();
    if (e === null) return;
    expect(e.cx).toBeCloseTo(340, 6);
    expect(e.cy).toBeCloseTo(220, 6);
    expect(e.a).toBeCloseTo(120, 6);
    expect(e.b).toBeCloseTo(50, 6);
    expect(fold(e.angle - 0.5)).toBeCloseTo(0, 6);
  });

  it("rejects strokes too short to mean anything", () => {
    expect(
      fitStrokeEllipse([
        { x: 0, y: 0 },
        { x: 1, y: 1 },
      ]),
    ).toBeNull();
  });
});

describe("sampling", () => {
  it("cholesky reproduces the covariance", () => {
    const g: Gaussian2D = { mx: 0, my: 0, sxx: 25, sxy: 10, syy: 16 };
    const L = cholesky2x2(g);
    expect(L.l11 * L.l11).toBeCloseTo(25, 10);
    expect(L.l11 * L.l21).toBeCloseTo(10, 10);
    expect(L.l21 * L.l21 + L.l22 * L.l22).toBeCloseTo(16, 8);
  });

  it("sample moments match a one-component mixture", () => {
    const mix: Mixture2D = {
      weights: [1],
      components: [{ mx: 40, my: -10, sxx: 100, sxy: 30, syy: 60 }],
    };
    const data = draws(mix, 40000);
    const n = data.length / 2;
    let mx = 0;
    let my = 0;
    for (let i = 0; i < n; i++) {
      mx += data[2 * i];
      my += data[2 * i + 1];
    }
    mx /= n;
    my /= n;
    let sxx = 0;
    let sxy = 0;
    let syy = 0;
    for (let i = 0; i < n; i++) {
      const dx = data[2 * i] - mx;
      const dy = data[2 * i + 1] - my;
      sxx += dx * dx;
      sxy += dx * dy;
      syy += dy * dy;
    }
    expect(mx).toBeCloseTo(40, 0);
    expect(my).toBeCloseTo(-10, 0);
    expect(sxx / n).toBeCloseTo(100, -1);
    expect(sxy / n).toBeCloseTo(30, -1);
    expect(syy / n).toBeCloseTo(60, -1);
  });

  it("respects mixture weights", () => {
    const mix: Mixture2D = {
      weights: [0.25, 0.75],
      components: [
        { mx: -100, my: 0, sxx: 4, sxy: 0, syy: 4 },
        { mx: 100, my: 0, sxx: 4, sxy: 0, syy: 4 },
      ],
    };
    const data = draws(mix, 20000);
    let left = 0;
    for (let i = 0; i + 1 < data.length; i += 2) {
      if (data[i] < 0) left++;
    }
    expect(left / 10000).toBeCloseTo(0.5, 1); // 25% of 20k
  });
});

describe("hexbin", () => {
  it("conserves in-board points and drops off-board ones", () => {
    const data = new Float64Array([10, 10, 10.5, 10.2, 300, 200, -5, 10, 10, 999]);
    const h = hexbin(data, 12, 680, 460);
    expect(h.binned).toBe(3);
    expect(h.bins.reduce((acc, b) => acc + b.count, 0)).toBe(3);
    expect(h.maxCount).toBe(2); // the two near-identical points share a hex
  });

  it("puts a point in the hex whose centre is nearest", () => {
    const h = hexbin(new Float64Array([100, 100]), 12, 680, 460);
    expect(h.bins).toHaveLength(1);
    const d = Math.hypot(h.bins[0].cx - 100, h.bins[0].cy - 100);
    expect(d).toBeLessThanOrEqual(12);
  });
});

describe("EM", () => {
  const truth = mixtureFromEllipses([
    { cx: 200, cy: 150, a: 90, b: 40, angle: 0.4 },
    { cx: 480, cy: 320, a: 60, b: 60, angle: 0 },
  ]);
  const data = draws(truth, 6000, 11);

  it("initial guess is sane", () => {
    const g0 = initialGuess2d(data, 3, mulberry32(1));
    expect(g0.components).toHaveLength(3);
    expect(g0.weights.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
    // k-means++ seeding spreads the centres apart.
    const [a, b, c] = g0.components;
    expect(Math.hypot(a.mx - b.mx, a.my - b.my)).toBeGreaterThan(10);
    expect(Math.hypot(a.mx - c.mx, a.my - c.my)).toBeGreaterThan(10);
  });

  it("log-likelihood climbs monotonically and the components are recovered", () => {
    let params = initialGuess2d(data, 2, mulberry32(3));
    let prev = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < 60; i++) {
      const step = emStep2d(data, params);
      expect(step.logLik).toBeGreaterThanOrEqual(prev - 1e-6);
      prev = step.logLik;
      params = step.params;
    }
    // Match recovered components to truth by nearest mean.
    for (const t of truth.components) {
      const nearest = params.components.reduce((best, c) =>
        Math.hypot(c.mx - t.mx, c.my - t.my) < Math.hypot(best.mx - t.mx, best.my - t.my)
          ? c
          : best,
      );
      expect(Math.hypot(nearest.mx - t.mx, nearest.my - t.my)).toBeLessThan(8);
      expect(nearest.sxx).toBeCloseTo(t.sxx, -2);
      expect(nearest.syy).toBeCloseTo(t.syy, -2);
    }
    // Weights near the equal-weight truth.
    for (const w of params.weights) {
      expect(w).toBeGreaterThan(0.35);
      expect(w).toBeLessThan(0.65);
    }
  });

  it("keeps covariances positive definite under adversarial data", () => {
    // All points identical: variances floor, correlation clamps.
    const degenerate = new Float64Array(200).fill(50);
    const step = emStep2d(degenerate, initialGuess2d(degenerate, 2, mulberry32(5)));
    for (const c of step.params.components) {
      expect(c.sxx * c.syy - c.sxy * c.sxy).toBeGreaterThan(0);
    }
  });

  it("contour constant is what the docs claim", () => {
    expect(CONTOUR_SIGMA).toBe(2);
  });
});
