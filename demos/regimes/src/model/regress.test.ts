import { describe, expect, it } from "vitest";
import {
  bestInFamily,
  decompose,
  ensemble,
  grid,
  makeDataset,
  polyEval,
  polyfit,
  signalVariance,
  trueF,
} from "./regress";

describe("polyfit", () => {
  it("recovers an in-family target exactly (no noise)", () => {
    const xs = grid(41);
    const ys = xs.map((x) => 2 + 3 * x - 1.5 * x * x);
    const coef = polyfit({ xs, ys }, 2);
    for (const x of [-0.9, -0.3, 0.2, 0.77]) {
      expect(polyEval(coef, x)).toBeCloseTo(2 + 3 * x - 1.5 * x * x, 6);
    }
  });

  it("is deterministic per seed via makeDataset", () => {
    expect(makeDataset(20, 0.3, 5)).toEqual(makeDataset(20, 0.3, 5));
  });
});

describe("bestInFamily", () => {
  it("degree 14 expresses f, degree 3 cannot", () => {
    const xs = grid(101);
    const err = (deg: number) => {
      const c = bestInFamily(deg);
      return xs.reduce((s, x) => s + (polyEval(c, x) - trueF(x)) ** 2, 0) / xs.length;
    };
    expect(err(14)).toBeLessThan(1e-3);
    expect(err(3)).toBeGreaterThan(0.05);
  });
});

describe("decompose", () => {
  it("floor is σ² and terms respond to their knobs", () => {
    const base = { degree: 6, n: 60, sigma: 0.5, trials: 24, seed: 1 };
    const d = decompose(base);
    expect(d.floor).toBeCloseTo(0.25, 12);
    expect(d.total).toBeCloseTo(d.floor + d.approximation + d.estimation, 12);

    // more data → less estimation
    const bigN = decompose({ ...base, n: 400 });
    expect(bigN.estimation).toBeLessThan(d.estimation);

    // more expressive family → less approximation
    const bigD = decompose({ ...base, degree: 12 });
    expect(bigD.approximation).toBeLessThan(d.approximation);
  });

  it("labels the extreme regimes", () => {
    // tiny family, lots of data: approximation-limited
    const a = decompose({ degree: 2, n: 500, sigma: 0.2, trials: 16, seed: 2 });
    expect(a.dominant).toBe("approximation");
    // rich family, scarce noisy data: estimation-limited
    const e = decompose({ degree: 12, n: 30, sigma: 0.6, trials: 16, seed: 3 });
    expect(e.dominant).toBe("estimation");
  });

  it("signal variance is order one for this f", () => {
    expect(signalVariance()).toBeGreaterThan(0.4);
    expect(signalVariance()).toBeLessThan(1);
  });
});

describe("ensemble", () => {
  it("averaging pays in the estimation-limited regime (in expectation)", () => {
    // any single member is a noisy draw, so average the M=1 vs M=16 comparison
    // over several independent runs before asserting the 1/M shrink
    let m1 = 0;
    let m16 = 0;
    for (let seed = 1; seed <= 6; seed++) {
      const r = ensemble({ degree: 8, n: 50, sigma: 1.0, maxM: 16, seed, heterogeneous: false });
      m1 += r.mseByM[0];
      m16 += r.mseByM[15];
      expect(r.disagreement).toBeGreaterThan(0);
    }
    expect(m16).toBeLessThan(m1 * 0.8);
  });

  it("averaging cannot buy expressiveness in the approximation-limited regime", () => {
    const r = ensemble({ degree: 2, n: 500, sigma: 0.1, maxM: 12, seed: 5, heterogeneous: false });
    // the floor of the curve is the approximation error — barely moves
    expect(r.mseByM[11]).toBeGreaterThan(r.mseByM[0] * 0.8);
  });
});
