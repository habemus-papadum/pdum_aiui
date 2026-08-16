import { describe, expect, it } from "vitest";
import { dieDistribution, entropyBits, FACES, pointwiseFloor, simulateDie } from "./dice";

describe("dieDistribution", () => {
  it("is a probability distribution at every loadedness", () => {
    for (const L of [0, 0.25, 0.5, 1]) {
      const p = dieDistribution(L);
      expect(p).toHaveLength(FACES);
      expect(p.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
      for (const q of p) expect(q).toBeGreaterThanOrEqual(0);
    }
  });

  it("interpolates fair → certain", () => {
    expect(dieDistribution(0)[0]).toBeCloseTo(1 / 6, 12);
    expect(dieDistribution(1)[FACES - 1]).toBeCloseTo(1, 12);
  });
});

describe("the two floors", () => {
  it("fair die: pointwise hopeless, distribution maximal entropy", () => {
    const p = dieDistribution(0);
    expect(pointwiseFloor(p)).toBeCloseTo(5 / 6, 12);
    expect(entropyBits(p)).toBeCloseTo(Math.log2(6), 12);
  });

  it("certain die: both games trivial", () => {
    const p = dieDistribution(1);
    expect(pointwiseFloor(p)).toBeCloseTo(0, 12);
    expect(entropyBits(p)).toBeCloseTo(0, 12);
  });
});

describe("simulateDie", () => {
  it("running scores converge to the floors", () => {
    const p = dieDistribution(0.3);
    const run = simulateDie(p, 4000, 42);
    expect(run.counts.reduce((a, b) => a + b, 0)).toBe(4000);
    expect(run.pointwiseErr.at(-1)).toBeCloseTo(pointwiseFloor(p), 1);
    expect(run.logLoss.at(-1)).toBeCloseTo(entropyBits(p), 1);
  });

  it("is deterministic per seed", () => {
    const p = dieDistribution(0.5);
    expect(simulateDie(p, 50, 7).rolls).toEqual(simulateDie(p, 50, 7).rolls);
  });
});
