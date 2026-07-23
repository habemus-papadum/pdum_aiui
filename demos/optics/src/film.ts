/**
 * film.ts — what a hologram physically IS: the memory mechanism.
 *
 * Film cannot see phase. During an exposure it integrates intensity — the
 * time-average of |E_total|² — and that is the *only* thing it keeps. The
 * pipeline modelled here is the darkroom's:
 *
 *   expose   silver-halide grains absorb photons at a rate ∝ local intensity;
 *            an interference pattern prints as a grain-density pattern.
 *   develop  exposed grains become opaque metallic silver: the film becomes an
 *            absorbing mask, t(x) darkening where the light was bright — an
 *            AMPLITUDE hologram (it works, but wastes the light it absorbs).
 *   bleach   optionally, silver is converted back to a transparent salt with a
 *            different refractive index: same stripes, now written in phase
 *            delay instead of absorption — a PHASE hologram (bright: nothing
 *            is absorbed, so far more light lands in the image).
 *
 * Two real-world imperfections ride along, because they are *design
 * constraints*, not footnotes:
 *
 *   coherence — the two arms only interfere while their path difference is
 *            within the laser's coherence length (match your path lengths!);
 *   stability — bench vibration during the exposure slides the fringes and
 *            averages them away (λ/4 of drift is already fatal — this is why
 *            holography tables are slabs of granite).
 */

import type { Transmission } from "./elements";
import { fft, fftfreq, ifft } from "./fft";
import { type SourceSpec, sourceAt } from "./field";

/** One arm's contribution at the film: its complex field and its *unwrapped*
 *  optical path from the laser, per sample (paths drive coherence damping). */
interface ArmAtFilm {
  re: Float64Array;
  im: Float64Array;
  path: Float64Array;
}

/** A source plus the extra path light travelled before it (laser → mirror →
 *  lens → this source's origin), so arms can be path-matched or mismatched. */
export interface ArmSpec {
  source: SourceSpec;
  /** Extra optical path upstream of the source origin, µm. */
  pathOffset?: number;
}

export interface ExposureOpts {
  /** Laser coherence length, µm (∞ = ideal single-frequency laser). */
  coherenceLength?: number;
  /** RMS bench drift during the exposure, in wavelengths (0 = granite). */
  vibrationRms?: number;
}

export interface ExposureResult {
  /** Time-integrated intensity per sample (arbitrary units). */
  exposure: Float64Array;
  /** Mean exposure (the bias the development step linearizes around). */
  mean: number;
  /** Fringe-contrast factor actually achieved for the *least* coherent pair
   *  (1 = perfect fringes, 0 = washed out) — the bench-quality meter. */
  worstContrast: number;
}

function armAtFilm(
  arm: ArmSpec,
  n: number,
  dx: number,
  x0: number,
  z: number,
  lambda: number,
): ArmAtFilm {
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const path = new Float64Array(n);
  const s = arm.source;
  const off = arm.pathOffset ?? 0;
  for (let i = 0; i < n; i++) {
    const x = x0 + i * dx;
    const e = sourceAt(s, x, z, lambda);
    re[i] = e.re;
    im[i] = e.im;
    if (s.kind === "plane") {
      const th = (s.angleDeg * Math.PI) / 180;
      path[i] = x * Math.sin(th) + z * Math.cos(th) + off;
    } else {
      path[i] = Math.hypot(x - s.x, z - s.z) + off;
    }
  }
  return { re, im, path };
}

/**
 * Integrate the exposure of a film line at plane z from a set of mutually
 * coherent arms. Direct terms always add; each *cross* term (the fringes!) is
 * damped by that pair's coherence overlap and by vibration:
 *
 *   E(x) = Σᵢ|Eᵢ|²  +  Σᵢ<ⱼ 2·γᵢⱼ(x)·V · Re(Eᵢ E*ⱼ)
 *
 *   γᵢⱼ = exp(−(Δpathᵢⱼ/Lc)²)      — arms interfere only where paths match
 *   V   = exp(−2(π·δ)²), δ in λ    — fringes smear as the bench drifts
 */
export function exposeFilm(
  arms: readonly ArmSpec[],
  n: number,
  dx: number,
  x0: number,
  z: number,
  lambda: number,
  opts?: ExposureOpts,
): ExposureResult {
  const fields = arms.map((a) => armAtFilm(a, n, dx, x0, z, lambda));
  const lc = opts?.coherenceLength ?? Number.POSITIVE_INFINITY;
  const vib = opts?.vibrationRms ?? 0;
  const vibFactor = Math.exp(-2 * (Math.PI * vib) ** 2);

  const exposure = new Float64Array(n);
  for (const f of fields) {
    for (let i = 0; i < n; i++) exposure[i] += f.re[i] * f.re[i] + f.im[i] * f.im[i];
  }
  let worstContrast = 1;
  for (let a = 0; a < fields.length; a++) {
    for (let b = a + 1; b < fields.length; b++) {
      const fa = fields[a];
      const fb = fields[b];
      let minGamma = 1;
      for (let i = 0; i < n; i++) {
        const dp = fa.path[i] - fb.path[i];
        const gamma = Number.isFinite(lc) ? Math.exp(-((dp / lc) ** 2)) : 1;
        if (gamma < minGamma) minGamma = gamma;
        const cross = fa.re[i] * fb.re[i] + fa.im[i] * fb.im[i]; // Re(Ea·Eb*)
        exposure[i] += 2 * gamma * vibFactor * cross;
      }
      const pairContrast = minGamma * vibFactor;
      if (pairContrast < worstContrast) worstContrast = pairContrast;
    }
  }
  let mean = 0;
  for (let i = 0; i < n; i++) mean += exposure[i];
  mean /= n;
  return { exposure, mean, worstContrast };
}

export interface DevelopOpts {
  /** "amplitude" = developed silver (absorbing); "phase" = bleached (clear). */
  mode: "amplitude" | "phase";
  /** Development strength γ ∈ [0, 1]: slope of t against exposure. */
  gamma: number;
  /** Peak phase excursion for bleached film, radians (≈2 is near-optimal). */
  phiMax?: number;
  /** Film resolution: the finest stripe period the emulsion can hold, µm.
   *  Finer detail is attenuated (Gaussian MTF, −50% at this period). Real
   *  holographic film resolves ~0.2 µm stripes — 25× finer than camera film,
   *  and the reason ordinary film cannot record a hologram. */
  cutoffPeriod?: number;
}

/**
 * Develop an exposure into a transmission t(x) — the recorded memory becomes
 * an optical *element* (elements.ts), and playback is just "apply it".
 *
 *   amplitude: t = clamp(1 − γ·E/2Ē)          (linear around the bias Ē)
 *   phase:     t = e^{i·φmax·E/2Ē}
 */
export function developFilm(
  exposure: Float64Array,
  meanExposure: number,
  grid: { dx: number; x0: number },
  opts: DevelopOpts,
): Transmission {
  const n = exposure.length;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const denom = meanExposure > 0 ? 2 * meanExposure : 1;
  const phiMax = opts.phiMax ?? 2;
  for (let i = 0; i < n; i++) {
    const u = exposure[i] / denom; // ≈ [0..1] for full-contrast two-beam fringes
    if (opts.mode === "amplitude") {
      re[i] = Math.min(1, Math.max(0, 1 - opts.gamma * u));
    } else {
      const ph = opts.gamma * phiMax * u;
      re[i] = Math.cos(ph);
      im[i] = Math.sin(ph);
    }
  }
  const t: Transmission = { n, dx: grid.dx, x0: grid.x0, re, im };
  if (opts.cutoffPeriod && opts.cutoffPeriod > 0) lowpassTransmission(t, opts.cutoffPeriod);
  return t;
}

/** Gaussian-MTF lowpass: attenuate spatial frequency ν by exp(−ln2·(ν·P)²)
 *  (−50% at period P). Models the emulsion's finite grain size. */
export function lowpassTransmission(t: Transmission, cutoffPeriod: number): void {
  const n = t.n;
  if ((n & (n - 1)) !== 0) throw new Error("lowpassTransmission needs a pow2 grid");
  const freqs = fftfreq(n, t.dx);
  const re = t.re;
  const im = t.im;
  fft(re, im);
  for (let i = 0; i < n; i++) {
    const g = Math.exp(-Math.LN2 * (freqs[i] * cutoffPeriod) ** 2);
    re[i] *= g;
    im[i] *= g;
  }
  ifft(re, im);
}

/**
 * Deterministic "grain view" of an exposure: dot positions whose density
 * follows the exposure — the film's memory as the emulsion actually stores it,
 * a census of blackened grains. Seeded (mulberry32) so tests and HMR replays
 * see the same film.
 */
export function grainDots(
  exposure: Float64Array,
  meanExposure: number,
  grid: { dx: number; x0: number },
  opts: { count: number; seed: number },
): Float32Array {
  let a = opts.seed >>> 0;
  const rand = (): number => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const n = exposure.length;
  const peak = meanExposure > 0 ? 2 * meanExposure : 1;
  const out = new Float32Array(opts.count * 2);
  let placed = 0;
  let guard = 0;
  while (placed < opts.count && guard < opts.count * 40) {
    guard++;
    const u = rand();
    const i = Math.min(n - 1, Math.floor(u * n));
    const accept = exposure[i] / (peak * 1.2);
    if (rand() < accept) {
      out[placed * 2] = grid.x0 + (i + rand()) * grid.dx;
      out[placed * 2 + 1] = rand(); // y ∈ [0,1) — the strip's thickness, for display
      placed++;
    }
  }
  return out.subarray(0, placed * 2);
}
