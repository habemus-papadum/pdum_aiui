import { describe, expect, it } from "vitest";
import { base, envelope, sampleWave, waveSummary } from "./wave";

describe("the specimen wave", () => {
  it("every shape is bounded by ±1 and the square takes only the extremes", () => {
    for (let i = 0; i < 100; i++) {
      const c = i / 37;
      expect(Math.abs(base("sine", c))).toBeLessThanOrEqual(1);
      expect(Math.abs(base("triangle", c))).toBeLessThanOrEqual(1);
      expect([1, -1]).toContain(base("square", c));
    }
  });

  it("the envelope starts at one and decays", () => {
    expect(envelope(0.6, 0)).toBe(1);
    expect(envelope(0.6, 2)).toBeCloseTo(Math.exp(-1.2));
    expect(envelope(0, 5)).toBe(1);
  });

  it("samples n points over the duration and crosses zero twice per cycle", () => {
    const pts = sampleWave({ frequency: 2, damping: 0, shape: "sine" }, 2001, 2);
    expect(pts).toHaveLength(2001);
    expect(pts[0].t).toBe(0);
    expect(pts[2000].t).toBe(2);
    const s = waveSummary(pts);
    // 2 Hz over 2 s is 4 cycles: 8 crossings, give or take the endpoint.
    expect(s.crossings).toBeGreaterThanOrEqual(7);
    expect(s.crossings).toBeLessThanOrEqual(8);
    expect(s.rms).toBeCloseTo(Math.SQRT1_2, 2);
    expect(s.peak).toBeCloseTo(1, 3);
  });

  it("damping lowers the RMS and the summary of nothing is zero", () => {
    const loud = waveSummary(sampleWave({ frequency: 1, damping: 0, shape: "square" }));
    const quiet = waveSummary(sampleWave({ frequency: 1, damping: 2, shape: "square" }));
    expect(loud.rms).toBeCloseTo(1, 6);
    expect(quiet.rms).toBeLessThan(loud.rms);
    expect(waveSummary([])).toEqual({ rms: 0, peak: 0, crossings: 0 });
  });
});
