import { describe, expect, it } from "vitest";
import { OneEuro, type OneEuroConfig, PointFilter, smoothingAlpha } from "./filter";

const CONFIG: OneEuroConfig = { minCutoff: 1.0, beta: 0.5, dCutoff: 1.0 };

describe("smoothingAlpha", () => {
  it("is 1 (no smoothing) when time did not pass", () => {
    // Two samples sharing a timestamp is the only sane place for this answer:
    // there is no elapsed time to filter over.
    expect(smoothingAlpha(1, 0)).toBe(1);
    expect(smoothingAlpha(1, -5)).toBe(1);
  });

  it("rises toward 1 as the cutoff rises (a higher cutoff filters less)", () => {
    const low = smoothingAlpha(0.5, 16);
    const high = smoothingAlpha(50, 16);
    expect(low).toBeGreaterThan(0);
    expect(low).toBeLessThan(high);
    expect(high).toBeLessThanOrEqual(1);
  });
});

describe("OneEuro", () => {
  it("passes the first sample through untouched", () => {
    const f = new OneEuro(CONFIG);
    expect(f.filter(42, 0)).toBe(42);
  });

  it("converges to a constant input", () => {
    const f = new OneEuro(CONFIG);
    f.filter(0, 0);
    let out = 0;
    for (let i = 1; i < 200; i++) {
      out = f.filter(10, i * 8);
    }
    expect(out).toBeCloseTo(10, 3);
  });

  it("suppresses jitter around a stationary value", () => {
    // A pen held still, trembling ±1px at 120Hz. What matters is that the
    // TREMOR is attenuated — not that the output has finished settling toward
    // the true mean, which is a slower and separate thing (the filter's first
    // sample is one of the noisy ones, and it has to walk down from there).
    const f = new OneEuro({ minCutoff: 0.5, beta: 0.0, dCutoff: 1.0 });
    const outputs: number[] = [];
    for (let i = 0; i < 300; i++) {
      outputs.push(f.filter(100 + (i % 2 === 0 ? 1 : -1), i * 8));
    }
    const tail = outputs.slice(-40);
    const peakToPeak = Math.max(...tail) - Math.min(...tail);

    // Input swings 2px peak-to-peak; the output must barely move.
    expect(peakToPeak).toBeLessThan(0.2);
    // And it should have settled onto the true value it was trembling around.
    const mean = tail.reduce((a, b) => a + b, 0) / tail.length;
    expect(mean).toBeCloseTo(100, 1);
  });

  it("gets OUT OF THE WAY when the input moves fast — the whole point of beta", () => {
    // This is the property the design rests on: a low-beta filter lags a moving
    // pen, and lag is what makes handwriting feel dead. Higher beta must track a
    // fast ramp more closely.
    const ramp = (beta: number): number => {
      const f = new OneEuro({ minCutoff: 0.5, beta, dCutoff: 1.0 });
      let out = 0;
      for (let i = 0; i < 30; i++) {
        out = f.filter(i * 20, i * 8); // 20px per 8ms — a quick stroke
      }
      return out;
    };
    const truth = 29 * 20;
    const sluggish = Math.abs(truth - ramp(0.0));
    const responsive = Math.abs(truth - ramp(2.0));
    expect(responsive).toBeLessThan(sluggish);
  });

  it("forgets everything on reset — a new stroke starts clean", () => {
    const f = new OneEuro(CONFIG);
    f.filter(0, 0);
    f.filter(0, 8);
    f.reset();
    expect(f.filter(500, 16)).toBe(500);
  });
});

describe("PointFilter", () => {
  it("filters both axes against one clock", () => {
    const f = new PointFilter(CONFIG);
    expect(f.filter(3, 4, 0)).toEqual({ x: 3, y: 4 });
    const next = f.filter(100, 200, 8);
    expect(next.x).toBeGreaterThan(3);
    expect(next.x).toBeLessThan(100);
    expect(next.y).toBeGreaterThan(4);
    expect(next.y).toBeLessThan(200);
  });
});
