/**
 * bragg.test.ts — the volume-hologram claims as tests: the stack reflects AT
 * the recording wavelength (Denisyuk's white-light trick), thickness buys
 * selectivity, modulation buys strength, shrinkage and tilt shift the color
 * exactly as the folklore says (because the folklore is Bragg's law).
 */
import { describe, expect, it } from "vitest";
import { braggCurve, braggReflectance } from "./bragg";

const BAND: readonly [number, number] = [4.5, 13.5];
const BASE = { lambdaRec: 8, deltaN: 0.03, periods: 30 };

describe("volume gratings (Bragg selection)", () => {
  it("reflects at the recording wavelength", () => {
    const c = braggCurve(BASE, BAND);
    expect(Math.abs(c.peakLambda - 8)).toBeLessThan(0.15);
    expect(c.peakR).toBeGreaterThan(0.3);
  });

  it("reflectance stays physical (0 ≤ R ≤ 1) across the band", () => {
    const c = braggCurve({ ...BASE, deltaN: 0.06, periods: 80 }, BAND);
    for (const r of c.reflect) {
      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThanOrEqual(1.000001);
    }
  });

  it("a thicker emulsion selects more narrowly (and reflects more)", () => {
    const thin = braggCurve({ ...BASE, periods: 6 }, BAND);
    const thick = braggCurve({ ...BASE, periods: 60 }, BAND);
    expect(thick.fwhm).toBeLessThan(thin.fwhm * 0.5);
    expect(thick.peakR).toBeGreaterThan(thin.peakR);
  });

  it("stronger index modulation reflects more", () => {
    const weak = braggCurve({ ...BASE, deltaN: 0.008 }, BAND);
    const strong = braggCurve({ ...BASE, deltaN: 0.05 }, BAND);
    expect(strong.peakR).toBeGreaterThan(weak.peakR * 1.5);
  });

  it("10% processing shrinkage shifts the color 10% toward the blue", () => {
    const c = braggCurve({ ...BASE, shrink: -0.1 }, BAND);
    expect(Math.abs(c.peakLambda - 8 * 0.9)).toBeLessThan(0.15);
  });

  it("tilting the hologram blue-shifts it (cos of the internal angle)", () => {
    const tilted = braggCurve({ ...BASE, tiltDeg: 35 }, BAND);
    const n0 = 1.5;
    const sinIn = Math.sin((35 * Math.PI) / 180) / n0;
    const expected = 8 * Math.sqrt(1 - sinIn * sinIn);
    expect(Math.abs(tilted.peakLambda - expected)).toBeLessThan(0.15);
    expect(tilted.peakLambda).toBeLessThan(8);
  });

  it("far off-Bragg, the film is nearly transparent (the AR-combiner property)", () => {
    expect(braggReflectance(BASE, 11)).toBeLessThan(0.02);
    expect(braggReflectance(BASE, 5.5)).toBeLessThan(0.02);
  });
});
