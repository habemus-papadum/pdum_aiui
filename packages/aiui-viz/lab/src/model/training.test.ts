import { describe, expect, it } from "vitest";
import {
  BATCH,
  clipSummary,
  DEFAULT_PARAMS,
  initialStep,
  sampleBatch,
  stepTraining,
  TERM_IDS,
  termMagnitudes,
} from "./training";

const P = DEFAULT_PARAMS;

describe("training dynamics", () => {
  it("is deterministic in the step", () => {
    const a = stepTraining(initialStep(), P);
    const b = stepTraining(initialStep(), P);
    expect(a).toEqual(b);
    expect(a.step).toBe(1);
  });

  it("settles: the surrogate and value error shrink over a long run", () => {
    let s = initialStep();
    for (let i = 0; i < 2000; i++) s = stepTraining(s, P);
    expect(s.policy).toBeLessThan(initialStep().policy / 3);
    expect(s.value).toBeLessThan(initialStep().value / 3);
    expect(s.kl).toBeGreaterThan(0);
  });

  it("a larger β holds the KL lower", () => {
    let lo = initialStep();
    let hi = initialStep();
    for (let i = 0; i < 1000; i++) {
      lo = stepTraining(lo, { ...P, beta: 0.02 });
      hi = stepTraining(hi, { ...P, beta: 0.4 });
    }
    expect(hi.kl).toBeLessThan(lo.kl);
  });

  it("shares are non-negative and sum to one, and follow the coefficients", () => {
    const t = stepTraining(initialStep(), P);
    const m = termMagnitudes(t, P);
    const sum = TERM_IDS.reduce((s, id) => s + m[id].share, 0);
    expect(sum).toBeCloseTo(1, 9);
    for (const id of TERM_IDS) expect(m[id].share).toBeGreaterThanOrEqual(0);
    const heavier = termMagnitudes(t, { ...P, cv: 1 });
    expect(heavier.value.value).toBeCloseTo(2 * m.value.value, 9);
  });
});

describe("the simulated batch", () => {
  it("has BATCH samples, and the side fractions partition it", () => {
    const b = sampleBatch(7, P);
    expect(b.ratios).toHaveLength(BATCH);
    expect(b.advantages).toHaveLength(BATCH);
    expect(b.clip.low + b.clip.inBand + b.clip.high).toBeCloseTo(1, 9);
    for (const r of b.ratios) expect(r).toBeGreaterThan(0);
  });

  it("clipped samples are a subset of the out-of-band ones, split by bound", () => {
    for (const step of [0, 3, 40, 400]) {
      const c = sampleBatch(step, P).clip;
      expect(c.clipped).toBeCloseTo(c.clippedLow + c.clippedHigh, 12);
      expect(c.clippedLow).toBeLessThanOrEqual(c.low + 1e-12);
      expect(c.clippedHigh).toBeLessThanOrEqual(c.high + 1e-12);
    }
  });

  it("the min takes the clipped argument exactly in PPO's two regimes", () => {
    // Recount by hand from the samples: positive advantage above the band,
    // negative advantage below it.
    const step = 2;
    const { ratios, advantages, clip } = sampleBatch(step, P);
    let clipped = 0;
    ratios.forEach((r, i) => {
      const a = advantages[i] as number;
      if ((a > 0 && r > 1 + P.epsilon) || (a < 0 && r < 1 - P.epsilon)) clipped++;
    });
    expect(clip.clipped).toBeCloseTo(clipped / BATCH, 12);
  });

  it("a wider band clips less; a larger β moves the policy less (smaller spread)", () => {
    const narrow = sampleBatch(1, { ...P, epsilon: 0.05 }).clip;
    const wide = sampleBatch(1, { ...P, epsilon: 0.5 }).clip;
    expect(wide.clipped).toBeLessThanOrEqual(narrow.clipped);
    expect(wide.inBand).toBeGreaterThan(narrow.inBand);
    expect(sampleBatch(1, { ...P, beta: 0.5 }).clip.sigma).toBeLessThan(
      sampleBatch(1, { ...P, beta: 0 }).clip.sigma,
    );
  });

  it("early steps clip more than late ones", () => {
    const early = clipSummary([0, 1, 2, 3, 4].map((s) => sampleStep(s))).mean;
    const late = clipSummary([2000, 2001, 2002, 2003, 2004].map((s) => sampleStep(s))).mean;
    expect(late.clipped).toBeLessThan(early.clipped);
  });

  it("clipSummary: one row per step, means in [0, 1]", () => {
    const steps = [sampleStep(0), sampleStep(1), sampleStep(2)];
    const { rows, mean } = clipSummary(steps);
    expect(rows.map((r) => r.step)).toEqual([0, 1, 2]);
    for (const v of Object.values(mean)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
    expect(mean.low).toBeCloseTo(steps.reduce((acc, t) => acc + t.clip.low, 0) / 3, 12);
  });
});

/** A step at an arbitrary index, for summaries (the run is a function of the index). */
function sampleStep(step: number) {
  let s = initialStep();
  if (step === 0) return s;
  // evolve is private; stepping from (step - 1) lands on `step`.
  s = { ...s, step: step - 1 };
  return stepTraining(s, P);
}
