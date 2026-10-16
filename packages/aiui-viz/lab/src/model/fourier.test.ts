import { describe, expect, it } from "vitest";
import { harmonicK, harmonicTex, miniWavePath, rmsError, sampleSeries } from "./fourier";

describe("square-wave series", () => {
  it("converges: more harmonics, less error", () => {
    const errors = [1, 2, 4, 9].map((n) => rmsError(sampleSeries(n)));
    for (let i = 1; i < errors.length; i++) {
      const prev = errors[i - 1] ?? Number.NaN;
      expect(errors[i]).toBeLessThan(prev);
    }
  });

  it("mutes a harmonic out of the sum", () => {
    const full = sampleSeries(3);
    const muted = sampleSeries(3, new Set([3]));
    expect(muted.every((p) => p.harmonics[1] === 0)).toBe(true);
    const i = 60;
    const m = muted[i];
    const f = full[i];
    if (m === undefined || f === undefined) throw new Error("sample missing");
    expect(m.sum).toBeCloseTo(f.sum - (f.harmonics[1] ?? Number.NaN), 12);
  });

  it("names the terms as the equation reads them", () => {
    expect(harmonicK(1)).toBe(1);
    expect(harmonicK(4)).toBe(7);
    expect(harmonicTex(1)).toBe("\\sin x");
    expect(harmonicTex(5)).toBe("\\frac{1}{5}\\sin 5x");
  });

  it("draws a miniature path inside its box", () => {
    const d = miniWavePath(3, 64, 24);
    expect(d.startsWith("M0.0,12.0")).toBe(true);
    const ys = [...d.matchAll(/,(-?[\d.]+)/g)].map((m) => Number(m[1]));
    expect(Math.max(...ys)).toBeLessThanOrEqual(24);
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(0);
  });
});
