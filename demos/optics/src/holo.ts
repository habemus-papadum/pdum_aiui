/**
 * holo.ts — the holographer's imaging equations: where the played-back image
 * of a recorded point actually forms, for ANY playback beam and wavelength.
 *
 * These few lines are the "design math" of the whole subject. Every beam near
 * the film is summarized by two numbers — the paraxial expansion of its phase,
 * φ(x)/k = a·x + b·x²/2:
 *
 *   a = arrival tilt (sinθ)          b = curvature (1/distance to its point;
 *                                        0 for a collimated beam)
 *
 * Recording stores the +1-order phase k₁[(a_o−a_r)x + (b_o−b_r)x²/2].
 * Playback with wavelength λ₂ = µλ₁ and a beam (a_p, b_p) emits
 *
 *   image beam:  a = a_p ± µ(a_o−a_r),   b = b_p ± µ(b_o−b_r)
 *
 * (+ = the image, − = its conjugate twin). Positive b diverges from a VIRTUAL
 * point behind the film; negative b converges to a REAL point in front of it.
 * Transverse magnification of a small object: M = µ·d_image/d_object.
 *
 * Everything the holograms notebook claims about playback — where the twin
 * sits, why λ-swap rescales depth by 1/µ (Gabor's electron-microscope plan),
 * how a curved playback beam acts as a magnifier — is this arithmetic. The
 * unit tests hold these predictions against the full wave simulation.
 */

/** Paraxial beam summary at the film plane. */
export interface BeamAtFilm {
  /** Tilt: sinθ of arrival direction. */
  a: number;
  /** Curvature: 1/(distance upstream to source point); 0 = collimated. */
  b: number;
}

export function planeBeam(angleDeg: number): BeamAtFilm {
  return { a: Math.sin((angleDeg * Math.PI) / 180), b: 0 };
}

/** A point source at transverse position x, distance d upstream of the film. */
export function pointBeam(x: number, d: number): BeamAtFilm {
  return { a: -x / d, b: 1 / d };
}

export interface HoloImagePrediction {
  kind: "virtual" | "real" | "collimated";
  /** Transverse position of the image point, µm (undefined if collimated). */
  x?: number;
  /** Distance from the film, µm: upstream (behind the film) for virtual,
   *  downstream (in front) for real. */
  dist?: number;
  /** Outgoing tilt sinθ (the beam's direction; for collimated, its only datum). */
  tilt: number;
  /** Transverse magnification µ·d_i/d_o for a small object at the point. */
  magnification?: number;
}

function classify(a: number, b: number, mu: number, dObj: number): HoloImagePrediction {
  if (Math.abs(b) < 1e-9) return { kind: "collimated", tilt: a };
  const x = -a / b;
  const d = Math.abs(1 / b);
  return {
    kind: b > 0 ? "virtual" : "real",
    x,
    dist: d,
    tilt: a,
    magnification: (mu * d) / dObj,
  };
}

/**
 * Predict both playback images of one recorded object point.
 *
 * @param object    the object point's beam at the film (pointBeam(x, d))
 * @param recordRef the recording reference beam
 * @param playRef   the playback beam
 * @param mu        λ_playback / λ_recording
 */
export function holoImages(
  object: BeamAtFilm,
  recordRef: BeamAtFilm,
  playRef: BeamAtFilm,
  mu: number,
): { image: HoloImagePrediction; twin: HoloImagePrediction } {
  const dObj = object.b > 0 ? 1 / object.b : Number.POSITIVE_INFINITY;
  const da = object.a - recordRef.a;
  const db = object.b - recordRef.b;
  return {
    image: classify(playRef.a + mu * da, playRef.b + mu * db, mu, dObj),
    twin: classify(playRef.a - mu * da, playRef.b - mu * db, mu, dObj),
  };
}
