/**
 * propagate.ts — free-space propagation by the angular-spectrum method: the
 * exact scalar propagator, which *is* Huygens' principle done with an FFT.
 *
 * Decompose the field into plane waves (FFT over x). A component with
 * transverse spatial frequency ν travels at angle sinθ = λν, and advancing it
 * by Δz just multiplies it by e^{i·kz·Δz} with kz = √(k² − kx²). Components
 * with |kx| > k are evanescent — they decay instead of travel, which the
 * propagator handles by switching the exponent to real decay.
 *
 * That one sentence — "spatial frequency ν travels at angle sinθ = λν" — is
 * the entire content of the grating equation, and the reason these notebooks
 * can treat gratings, lenses, and holograms as one subject.
 */
import { fft, fftfreq, ifft, nextPow2 } from "./fft";
import { type Field, taperEdges, zeroField } from "./field";

/** A reusable propagation plan: the padded spectrum of a source plane. */
export interface PropagationPlan {
  /** Padded FFT length. */
  m: number;
  /** Grid geometry of the source plane (crop target). */
  n: number;
  dx: number;
  x0: number;
  lambda: number;
  /** kz per spectral bin: kzRe travels, kzIm ≥ 0 decays (evanescent). */
  kzRe: Float64Array;
  kzIm: Float64Array;
  /** The spectrum of the (edge-tapered, zero-padded) source field. */
  specRe: Float64Array;
  specIm: Float64Array;
}

/**
 * Build a plan from a field at plane z₀. `pad` multiplies the FFT length
 * (≥ 2 keeps periodic wraparound off the picture for the propagation
 * distances these benches use).
 */
export function planPropagation(field: Field, lambda: number, pad = 2): PropagationPlan {
  const m = nextPow2(field.n * pad);
  const specRe = new Float64Array(m);
  const specIm = new Float64Array(m);
  const off = (m - field.n) >> 1;
  const tapered = { ...field, re: field.re.slice(), im: field.im.slice() };
  taperEdges(tapered);
  specRe.set(tapered.re, off);
  specIm.set(tapered.im, off);
  fft(specRe, specIm);

  const k = (2 * Math.PI) / lambda;
  const freqs = fftfreq(m, field.dx);
  const kzRe = new Float64Array(m);
  const kzIm = new Float64Array(m);
  for (let i = 0; i < m; i++) {
    const kx = 2 * Math.PI * freqs[i];
    const d = k * k - kx * kx;
    if (d >= 0) kzRe[i] = Math.sqrt(d);
    else kzIm[i] = Math.sqrt(-d);
  }
  return { m, n: field.n, dx: field.dx, x0: field.x0, lambda, kzRe, kzIm, specRe, specIm };
}

/**
 * Evaluate the planned field at distance dz (> 0 downstream; the padded FFT
 * grid is centred on the source plane, so the crop returns the same x-window).
 */
export function propagateTo(plan: PropagationPlan, dz: number): Field {
  const { m, kzRe, kzIm, specRe, specIm } = plan;
  const re = new Float64Array(m);
  const im = new Float64Array(m);
  for (let i = 0; i < m; i++) {
    // H = e^{i·kzRe·dz} · e^{−kzIm·dz}
    const decay = kzIm[i] > 0 ? Math.exp(-kzIm[i] * Math.abs(dz)) : 1;
    const ph = kzRe[i] * dz;
    const hRe = Math.cos(ph) * decay;
    const hIm = Math.sin(ph) * decay;
    re[i] = specRe[i] * hRe - specIm[i] * hIm;
    im[i] = specRe[i] * hIm + specIm[i] * hRe;
  }
  ifft(re, im);
  const out = zeroField(plan.n, plan.dx, plan.x0);
  const off = (m - plan.n) >> 1;
  out.re.set(re.subarray(off, off + plan.n));
  out.im.set(im.subarray(off, off + plan.n));
  return out;
}

/** One-shot: propagate a field by dz. */
export function propagate(field: Field, lambda: number, dz: number): Field {
  return propagateTo(planPropagation(field, lambda), dz);
}

// --- far field ---------------------------------------------------------------

/** Far-field (angular) power spectrum of a field. */
export interface FarField {
  /** sinθ per bin (uniform grid over [−sinMax, sinMax]). */
  sin: Float64Array;
  /** |A(sinθ)|², normalized to peak 1 unless `raw`. */
  power: Float64Array;
  /** Complex amplitude per bin (for efficiency integrals). */
  ampRe: Float64Array;
  ampIm: Float64Array;
}

/**
 * The far field IS the Fourier transform of the exit field: each transverse
 * frequency ν = one outgoing direction sinθ = λν. 4× zero-padding smooths the
 * curve; bins beyond |sinθ| = 1 are evanescent and dropped.
 */
export function farField(
  field: Field,
  lambda: number,
  opts?: { sinMax?: number; raw?: boolean },
): FarField {
  const sinMax = Math.min(opts?.sinMax ?? 1, 1);
  const m = nextPow2(field.n * 4);
  const re = new Float64Array(m);
  const im = new Float64Array(m);
  const off = (m - field.n) >> 1;
  const tapered = { ...field, re: field.re.slice(), im: field.im.slice() };
  taperEdges(tapered);
  re.set(tapered.re, off);
  im.set(tapered.im, off);
  fft(re, im);

  const freqs = fftfreq(m, field.dx);
  const pairs: { s: number; i: number }[] = [];
  for (let i = 0; i < m; i++) {
    const s = lambda * freqs[i];
    if (Math.abs(s) <= sinMax) pairs.push({ s, i });
  }
  pairs.sort((a, b) => a.s - b.s);
  const sin = new Float64Array(pairs.length);
  const power = new Float64Array(pairs.length);
  const ampRe = new Float64Array(pairs.length);
  const ampIm = new Float64Array(pairs.length);
  let peak = 0;
  for (let j = 0; j < pairs.length; j++) {
    const { s, i } = pairs[j];
    sin[j] = s;
    ampRe[j] = re[i];
    ampIm[j] = im[i];
    power[j] = re[i] * re[i] + im[i] * im[i];
    if (power[j] > peak) peak = power[j];
  }
  if (!opts?.raw && peak > 0) {
    for (let j = 0; j < power.length; j++) power[j] /= peak;
  }
  return { sin, power, ampRe, ampIm };
}

/**
 * Fraction of far-field power within |sinθ − sinθ₀| < halfWidth — the
 * diffraction-efficiency meter: how much of the light a grating/hologram
 * actually sends into a chosen order.
 */
export function powerInBand(ff: FarField, sin0: number, halfWidth: number): number {
  let inBand = 0;
  let total = 0;
  for (let j = 0; j < ff.sin.length; j++) {
    const p = ff.ampRe[j] * ff.ampRe[j] + ff.ampIm[j] * ff.ampIm[j];
    total += p;
    if (Math.abs(ff.sin[j] - sin0) < halfWidth) inBand += p;
  }
  return total > 0 ? inBand / total : 0;
}
