/**
 * wave.test.ts — the physics claims of the notebooks, held as unit tests
 * against the wave engine. Each test is one sentence the pages assert:
 * propagation preserves a plane wave, a sinusoidal grating makes exactly
 * three beams at the grating-equation angles with the classic efficiencies,
 * a zone plate focuses at f = f(λ), and the far field is the aperture's
 * Fourier transform.
 */
import { describe, expect, it } from "vitest";
import { apertureWindow, composeTransmission, uniformGrating, zonePlate } from "./elements";
import { applyTransmission, type Field, sourceAt, sourcesOnGrid } from "./field";
import { farField, planPropagation, powerInBand, propagate, propagateTo } from "./propagate";

const LAMBDA = 8; // µm — the benches' scaled-up light
const N = 2048;
const DX = 0.75;
const X0 = -(N * DX) / 2; // −768 µm

function planeField(angleDeg: number, z = 0): Field {
  return sourcesOnGrid([{ kind: "plane", angleDeg, amp: 1 }], N, DX, X0, z, LAMBDA);
}

/** Interior samples only (the propagator tapers the outer 8%). */
function interior(f: Field): { lo: number; hi: number } {
  return { lo: Math.floor(f.n * 0.25), hi: Math.ceil(f.n * 0.75) };
}

describe("propagation (angular spectrum = Huygens)", () => {
  it("a plane wave stays a plane wave, phase-advanced by k·cosθ·dz", () => {
    const angle = 6;
    const dz = 200;
    const out = propagate(planeField(angle, 0), LAMBDA, dz);
    const { lo, hi } = interior(out);
    for (let i = lo; i < hi; i += 37) {
      const want = sourceAt({ kind: "plane", angleDeg: angle, amp: 1 }, X0 + i * DX, dz, LAMBDA);
      expect(out.re[i]).toBeCloseTo(want.re, 2);
      expect(out.im[i]).toBeCloseTo(want.im, 2);
    }
  });

  it("a point source's field propagates like the analytic spherical wave", () => {
    const src = { kind: "point", x: 30, z: -500, amp: 1 } as const;
    const at0 = sourcesOnGrid([src], N, DX, X0, 0, LAMBDA);
    const out = propagate(at0, LAMBDA, 300);
    const { lo, hi } = interior(out);
    let err = 0;
    let ref = 0;
    for (let i = lo; i < hi; i++) {
      const want = sourceAt(src, X0 + i * DX, 300, LAMBDA);
      err += (out.re[i] - want.re) ** 2 + (out.im[i] - want.im) ** 2;
      ref += want.re ** 2 + want.im ** 2;
    }
    expect(Math.sqrt(err / ref)).toBeLessThan(0.05);
  });
});

describe("gratings (the grating equation + classic efficiencies)", () => {
  it("a sinusoidal amplitude grating makes exactly 0 and ±1 orders at sinθ = ±λ/Λ", () => {
    const pitch = 40;
    const f = planeField(0);
    const t = uniformGrating(N, DX, X0, { pitch, mode: "amplitude", contrast: 1 });
    applyTransmission(f, t.re, t.im);
    const ff = farField(f, LAMBDA, { raw: true });
    const s1 = LAMBDA / pitch; // 0.2

    // orders where predicted…
    const eta = (s: number): number => powerInBand(ff, s, 0.02);
    const e0 = eta(0);
    const ePlus = eta(s1);
    const eMinus = eta(-s1);
    // …and nowhere else (no ±2 order from a pure sinusoid)
    const e2 = eta(2 * s1);
    expect(ePlus).toBeGreaterThan(0.12);
    expect(eMinus).toBeGreaterThan(0.12);
    expect(e2).toBeLessThan(0.005);
    // of the transmitted power: DC ¼, each order 1/16 → 2/3, 1/6, 1/6
    expect(e0).toBeCloseTo(2 / 3, 1);
    expect(ePlus).toBeCloseTo(1 / 6, 1);
    expect(eMinus).toBeCloseTo(1 / 6, 1);
  });

  it("a thin phase grating at the optimal depth puts ~34% into the +1 order (J₁ max)", () => {
    const pitch = 40;
    const f = planeField(0);
    // stripePattern phase mode: t = e^{i(φmax/2)cosΦ}; J₁ peaks at argument 1.84
    const t = uniformGrating(N, DX, X0, { pitch, mode: "phase", phiMax: 3.68 });
    applyTransmission(f, t.re, t.im);
    const ff = farField(f, LAMBDA, { raw: true });
    const s1 = LAMBDA / pitch;
    expect(powerInBand(ff, s1, 0.02)).toBeGreaterThan(0.3);
    expect(powerInBand(ff, s1, 0.02)).toBeLessThan(0.37);
  });

  it("oblique incidence shifts every order by sinθin (the full grating equation)", () => {
    const pitch = 40;
    const inc = 5; // degrees
    const f = planeField(inc);
    const t = uniformGrating(N, DX, X0, { pitch, mode: "amplitude", contrast: 1 });
    applyTransmission(f, t.re, t.im);
    const ff = farField(f, LAMBDA, { raw: true });
    const sIn = Math.sin((inc * Math.PI) / 180);
    expect(powerInBand(ff, sIn + LAMBDA / pitch, 0.02)).toBeGreaterThan(0.1);
    expect(powerInBand(ff, sIn, 0.02)).toBeGreaterThan(0.4);
  });
});

describe("zone plates (a lens made of stripes)", () => {
  function axialPeak(lambda: number, fDesign: number): number {
    const f = sourcesOnGrid([{ kind: "plane", angleDeg: 0, amp: 1 }], N, DX, X0, 0, lambda);
    const zp = zonePlate(N, DX, X0, { f: fDesign, lambda: LAMBDA, mode: "phase", phiMax: Math.PI });
    const ap = apertureWindow(N, DX, X0, { center: 0, width: 300 });
    const t = composeTransmission(zp, ap);
    applyTransmission(f, t.re, t.im);
    const plan = planPropagation(f, lambda);
    let bestZ = 0;
    let best = 0;
    for (let z = fDesign * 0.5; z <= fDesign * 1.6; z += fDesign * 0.02) {
      const out = propagateTo(plan, z);
      const c = Math.floor(N / 2);
      let axial = 0;
      for (let i = c - 4; i <= c + 4; i++) axial += out.re[i] ** 2 + out.im[i] ** 2;
      if (axial > best) {
        best = axial;
        bestZ = z;
      }
    }
    return bestZ;
  }

  it("focuses a plane wave at the design focal length", () => {
    const z = axialPeak(LAMBDA, 500);
    expect(Math.abs(z - 500) / 500).toBeLessThan(0.08);
  });

  it("is chromatic: f scales as 1/λ (the spectrometer's dispersion, reappearing as a lens defect)", () => {
    const z = axialPeak(LAMBDA * 1.25, 500);
    expect(Math.abs(z - 500 / 1.25) / 400).toBeLessThan(0.08);
  });
});
