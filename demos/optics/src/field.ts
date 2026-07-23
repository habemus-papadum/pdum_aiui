/**
 * field.ts — the one primitive of the whole notebook pair: monochromatic light
 * at a plane is an array of phase arrows (complex amplitudes) on a uniform
 * transverse grid. Everything an optical system does is:
 *
 *   1. free-space propagation — a linear operator on this array (propagate.ts),
 *   2. an element — pointwise multiplication by its transmission t(x) (elements.ts),
 *   3. detection — |E|², which forgets phase (this file; film.ts records it).
 *
 * The world is 2-D: x is the transverse axis (along a film line), z the optical
 * axis (light travels toward +z). All lengths are µm. Wavelengths on these
 * "benches" are scaled up (λ ~ 4–14 µm rather than 0.4–0.7) so that the wave
 * texture is *visible* on screen; diffraction physics is scale-free in λ — only
 * ratios like λ/Λ enter — so every angle and every fringe count is faithful.
 */

/** A sampled complex field on a uniform 1-D grid: E[i] lives at x0 + i·dx. */
export interface Field {
  n: number;
  /** Sample spacing, µm. */
  dx: number;
  /** Coordinate of sample 0, µm. */
  x0: number;
  re: Float64Array;
  im: Float64Array;
}

/** Allocate a zero field. */
export function zeroField(n: number, dx: number, x0: number): Field {
  return { n, dx, x0, re: new Float64Array(n), im: new Float64Array(n) };
}

/** Deep-copy a field. */
export function cloneField(f: Field): Field {
  return { n: f.n, dx: f.dx, x0: f.x0, re: f.re.slice(), im: f.im.slice() };
}

/** The x coordinate of sample i. */
export function fieldX(f: Field, i: number): number {
  return f.x0 + i * f.dx;
}

/** Pointwise multiply field by a transmission (same grid): E ← E·t. */
export function applyTransmission(f: Field, tRe: Float64Array, tIm: Float64Array): void {
  for (let i = 0; i < f.n; i++) {
    const r = f.re[i] * tRe[i] - f.im[i] * tIm[i];
    f.im[i] = f.re[i] * tIm[i] + f.im[i] * tRe[i];
    f.re[i] = r;
  }
}

/** Add g into f (same grid). */
export function addField(f: Field, g: Field): void {
  for (let i = 0; i < f.n; i++) {
    f.re[i] += g.re[i];
    f.im[i] += g.im[i];
  }
}

/** Intensity |E|² per sample — what any detector (film, eye, camera) sees. */
export function intensity(f: Field): Float64Array {
  const out = new Float64Array(f.n);
  for (let i = 0; i < f.n; i++) out[i] = f.re[i] * f.re[i] + f.im[i] * f.im[i];
  return out;
}

/** Total power Σ|E|²·dx. */
export function power(f: Field): number {
  let s = 0;
  for (let i = 0; i < f.n; i++) s += f.re[i] * f.re[i] + f.im[i] * f.im[i];
  return s * f.dx;
}

// --- sources -----------------------------------------------------------------
//
// Sources are *analytic*: they can be evaluated at any (x, z) point, which is
// what lets field maps show the region upstream of an element exactly, with no
// grid propagation at all.

export type SourceSpec =
  | {
      kind: "plane";
      /** Propagation direction, degrees from the +z axis (positive tilts toward +x). */
      angleDeg: number;
      amp: number;
      /** Phase at the origin (x=0, z=0), radians. */
      phase?: number;
    }
  | {
      kind: "point";
      /** Source position, µm. Must sit upstream (z < element/film plane). */
      x: number;
      z: number;
      amp: number;
      phase?: number;
    };

/**
 * Evaluate one source's complex field at (x, z). Point sources are cylindrical
 * waves (this is a 2-D world): amplitude falls as 1/√r, normalized so that
 * |E| ≈ amp one wavelength from the source. The 1/√r envelope is the 2-D
 * far-field of Huygens' wavelet; its exact near-field shape (Hankel) differs
 * only within ~λ of the source, which no bench here samples.
 */
export function sourceAt(
  s: SourceSpec,
  x: number,
  z: number,
  lambda: number,
): { re: number; im: number } {
  const k = (2 * Math.PI) / lambda;
  if (s.kind === "plane") {
    const th = (s.angleDeg * Math.PI) / 180;
    const ph = k * (x * Math.sin(th) + z * Math.cos(th)) + (s.phase ?? 0);
    return { re: s.amp * Math.cos(ph), im: s.amp * Math.sin(ph) };
  }
  const dxs = x - s.x;
  const dzs = z - s.z;
  const r = Math.hypot(dxs, dzs);
  const a = s.amp / Math.sqrt(Math.max(r, lambda) / lambda);
  const ph = k * r + (s.phase ?? 0);
  return { re: a * Math.cos(ph), im: a * Math.sin(ph) };
}

/** Sample the coherent sum of sources onto a grid at plane z. */
export function sourcesOnGrid(
  sources: readonly SourceSpec[],
  n: number,
  dx: number,
  x0: number,
  z: number,
  lambda: number,
): Field {
  const f = zeroField(n, dx, x0);
  for (const s of sources) {
    for (let i = 0; i < n; i++) {
      const e = sourceAt(s, x0 + i * dx, z, lambda);
      f.re[i] += e.re;
      f.im[i] += e.im;
    }
  }
  return f;
}

/**
 * Soft-edge the outer `frac` of a field (supergaussian taper). Applied before
 * FFT propagation so the periodic wraparound of the angular-spectrum method
 * doesn't fold hard edges back into the picture.
 */
export function taperEdges(f: Field, frac = 0.08): void {
  const w = Math.max(2, Math.round(f.n * frac));
  for (let i = 0; i < w; i++) {
    const u = i / w; // 0 at the very edge → 1 inside
    const g = 1 - (1 - u) ** 2 * (1 - u) ** 2; // smooth C¹ ramp
    f.re[i] *= g;
    f.im[i] *= g;
    f.re[f.n - 1 - i] *= g;
    f.im[f.n - 1 - i] *= g;
  }
}
