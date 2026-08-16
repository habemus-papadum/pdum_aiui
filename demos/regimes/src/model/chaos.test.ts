import { describe, expect, it } from "vitest";
import { divergence, invariantHistogram, LYAPUNOV, step, trajectoryPair } from "./chaos";

describe("logistic map", () => {
  it("maps [0,1] into [0,1] with fixed points 0 and 3/4", () => {
    expect(step(0)).toBe(0);
    expect(step(0.75)).toBeCloseTo(0.75, 12);
    expect(step(0.5)).toBe(1);
    for (let i = 0; i <= 20; i++) {
      const v = step(i / 20);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

describe("divergence", () => {
  it("errors grow then saturate; smaller ε buys a longer horizon", () => {
    const wide = divergence(1e-3, 40, 300, 11);
    const narrow = divergence(1e-9, 40, 300, 11);
    expect(wide.meanErr[0]).toBeCloseTo(1e-3, 6);
    // grows by orders of magnitude within a dozen steps
    expect(wide.meanErr[12]).toBeGreaterThan(wide.meanErr[0] * 50);
    // roughly doubles per step early on (λ = ln 2)
    expect(Math.exp(LYAPUNOV)).toBeCloseTo(2, 12);
    // horizon lengthens as ε shrinks
    expect(narrow.horizonSteps).toBeGreaterThan(wide.horizonSteps + 10);
  });
});

describe("invariantHistogram", () => {
  it("occupancy converges to the arcsine law", () => {
    const h = invariantHistogram(200_000, 40, 3);
    // compare away from the integrable edge singularities
    let err = 0;
    let count = 0;
    for (let b = 4; b < 36; b++) {
      err += Math.abs(h.density[b] - h.arcsine[b]) / h.arcsine[b];
      count += 1;
    }
    expect(err / count).toBeLessThan(0.05);
  });
});

describe("trajectoryPair", () => {
  it("stays in [0,1] and frays from identical beginnings", () => {
    const p = trajectoryPair(0.2, 1e-6, 40);
    for (let i = 0; i <= 40; i++) {
      expect(p.a[i]).toBeGreaterThanOrEqual(0);
      expect(p.a[i]).toBeLessThanOrEqual(1);
    }
    expect(Math.abs(p.a[1] - p.b[1])).toBeLessThan(1e-4);
    const late = p.n.map((_, i) => Math.abs(p.a[i] - p.b[i])).slice(25);
    expect(Math.max(...late)).toBeGreaterThan(0.05);
  });
});
