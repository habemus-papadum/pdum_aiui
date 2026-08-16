import { describe, expect, it } from "vitest";
import { lossCurve, MODES, spectralState } from "./spectral";

describe("spectralState", () => {
  it("starts unlearned and converges to the target", () => {
    const t0 = spectralState(1, 0);
    expect(t0.learned.every((v) => v === 0)).toBe(true);
    expect(t0.loss).toBeCloseTo(t0.loss0, 12);

    const tEnd = spectralState(1, 1e7);
    for (let k = 0; k < MODES; k++) expect(tEnd.learned[k]).toBeCloseTo(tEnd.target[k], 6);
    expect(tEnd.loss).toBeLessThan(1e-6);
  });

  it("learns coarse before fine: residual fraction increases with k", () => {
    const s = spectralState(1, 30);
    for (let k = 1; k < MODES; k++) {
      expect(s.residualFrac[k]).toBeGreaterThanOrEqual(s.residualFrac[k - 1]);
    }
    // mode 1 essentially done, mode 20 essentially untouched
    expect(s.residualFrac[0]).toBeLessThan(1e-10);
    expect(s.residualFrac[19]).toBeGreaterThan(0.9);
  });

  it("white spectrum (α = 0) keeps energy in slow modes: loss stalls high", () => {
    const smooth = spectralState(2, 100);
    const white = spectralState(0, 100);
    expect(white.loss / white.loss0).toBeGreaterThan(5 * (smooth.loss / smooth.loss0));
  });
});

describe("lossCurve", () => {
  it("is monotone non-increasing in t", () => {
    const { loss } = lossCurve(1.2);
    for (let i = 1; i < loss.length; i++) expect(loss[i]).toBeLessThanOrEqual(loss[i - 1] + 1e-12);
  });
});
