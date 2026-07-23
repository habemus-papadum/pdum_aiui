/**
 * eye.ts — an honest eye: a pupil that clips a patch of wavefront, a lens that
 * adds quadratic phase, a retina that sees |E|². Nothing else.
 *
 * This is how the notebooks put "3-D" on a flat screen without cheating: the
 * reconstructed wavefront is *computed*, and this model is the only thing that
 * turns wavefronts into "what you would see". Parallax, accommodation blur,
 * and the aperture-vs-sharpness tradeoff of a cut-down hologram all fall out —
 * none of them are drawn in.
 *
 * Geometry: the source field lives on a line at z = zField; the eye sits
 * downstream at z = zField + standoff, looking back toward −z. Retina
 * positions are reported as *apparent transverse position at the focus depth*
 * (the un-inverted view), so plots read like the scene.
 */
import type { Field } from "./field";

export interface EyeSpec {
  /** Pupil centre, µm (slides along the viewing rail). */
  x: number;
  /** Pupil plane distance downstream of the field line, µm. */
  standoff: number;
  /** Pupil width, µm. */
  aperture: number;
  /** Focus distance in front of the pupil, µm (accommodation). */
  focusDepth: number;
  /** Retina distance behind the lens, µm. */
  retinaDist?: number;
  /** Retina pixel count. */
  nRetina?: number;
  /** Half-width of the viewed patch at the focus plane, µm. */
  viewHalfWidth?: number;
  /** Pupil sample count. */
  nPupil?: number;
}

export interface RetinaImage {
  /** Apparent transverse position at the focus plane per pixel, µm. */
  xApparent: Float64Array;
  intensity: Float64Array;
  peak: number;
}

/** Huygens kernel between two points (2-D world: 1/√r envelope). */
function kernel(lambda: number, dx: number, dz: number): { re: number; im: number; r: number } {
  const r = Math.hypot(dx, dz);
  const a = 1 / Math.sqrt(Math.max(r, lambda) / lambda);
  const ph = ((2 * Math.PI) / lambda) * r;
  return { re: a * Math.cos(ph), im: a * Math.sin(ph), r };
}

/**
 * Form the retinal image of a field line. Two Huygens sums with a lens phase
 * between them — the eye, with no further modelling assumptions.
 */
export function retinaImage(field: Field, lambda: number, eye: EyeSpec): RetinaImage {
  const nP = eye.nPupil ?? 128;
  const nR = eye.nRetina ?? 160;
  const R = eye.retinaDist ?? 240;
  const viewHalf = eye.viewHalfWidth ?? eye.focusDepth * 0.45;

  // 1. pupil field: Huygens sum from every field sample to each pupil sample
  const pRe = new Float64Array(nP);
  const pIm = new Float64Array(nP);
  const k = (2 * Math.PI) / lambda;
  for (let j = 0; j < nP; j++) {
    const u = ((j + 0.5) / nP - 0.5) * eye.aperture;
    const xp = eye.x + u;
    let sr = 0;
    let si = 0;
    for (let i = 0; i < field.n; i++) {
      const kx = xp - (field.x0 + i * field.dx);
      const kv = kernel(lambda, kx, eye.standoff);
      sr += field.re[i] * kv.re - field.im[i] * kv.im;
      si += field.re[i] * kv.im + field.im[i] * kv.re;
    }
    // 2. lens: focus depth d and retina distance R → 1/f = 1/d + 1/R
    const f = 1 / (1 / eye.focusDepth + 1 / R);
    const lensPh = (-k * u * u) / (2 * f);
    const lr = Math.cos(lensPh);
    const li = Math.sin(lensPh);
    pRe[j] = sr * lr - si * li;
    pIm[j] = sr * li + si * lr;
  }

  // 3. retina: Huygens sum pupil → retina plane at distance R
  const xApparent = new Float64Array(nR);
  const intensity = new Float64Array(nR);
  let peak = 0;
  const magnify = eye.focusDepth / R; // retina coord → apparent scene coord
  for (let m = 0; m < nR; m++) {
    const xa = ((m + 0.5) / nR - 0.5) * 2 * viewHalf; // apparent position
    const v = (-(xa - 0) / magnify) * 1; // inverted image on the retina
    let sr = 0;
    let si = 0;
    for (let j = 0; j < nP; j++) {
      const u = ((j + 0.5) / nP - 0.5) * eye.aperture;
      const kv = kernel(lambda, v - u, R);
      sr += pRe[j] * kv.re - pIm[j] * kv.im;
      si += pRe[j] * kv.im + pIm[j] * kv.re;
    }
    xApparent[m] = eye.x + xa;
    intensity[m] = sr * sr + si * si;
    if (intensity[m] > peak) peak = intensity[m];
  }
  return { xApparent, intensity, peak };
}
