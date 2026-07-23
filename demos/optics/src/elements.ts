/**
 * elements.ts — optical elements as transmission functions t(x): a complex
 * factor the element multiplies into the field at its plane. That one idea
 * covers everything on these benches — slits, gratings, chirped gratings, zone
 * plates, ideal lenses, apertures, and (in film.ts) developed holograms.
 *
 * Builders return { re, im } on an explicit grid so they can be applied with
 * `applyTransmission` or shipped to a worker.
 */

/** A transmission pattern on a grid (same layout as Field, without being one). */
export interface Transmission {
  n: number;
  dx: number;
  x0: number;
  re: Float64Array;
  im: Float64Array;
}

export function unityTransmission(n: number, dx: number, x0: number): Transmission {
  const re = new Float64Array(n).fill(1);
  return { n, dx, x0, re, im: new Float64Array(n) };
}

/** Multiply another transmission into this one (compose elements at a plane). */
export function composeTransmission(a: Transmission, b: Transmission): Transmission {
  const re = new Float64Array(a.n);
  const im = new Float64Array(a.n);
  for (let i = 0; i < a.n; i++) {
    re[i] = a.re[i] * b.re[i] - a.im[i] * b.im[i];
    im[i] = a.re[i] * b.im[i] + a.im[i] * b.re[i];
  }
  return { n: a.n, dx: a.dx, x0: a.x0, re, im };
}

/** N identical slits on pitch Λ, centred on `center`: the classic mask. */
export function slitArray(
  n: number,
  dx: number,
  x0: number,
  opts: { pitch: number; slitWidth: number; count: number; center?: number },
): Transmission {
  const t = { n, dx, x0, re: new Float64Array(n), im: new Float64Array(n) };
  const c = opts.center ?? 0;
  const first = c - ((opts.count - 1) / 2) * opts.pitch;
  for (let i = 0; i < n; i++) {
    const x = x0 + i * dx;
    // nearest slit index
    const j = Math.round((x - first) / opts.pitch);
    if (j < 0 || j >= opts.count) continue;
    const xc = first + j * opts.pitch;
    if (Math.abs(x - xc) <= opts.slitWidth / 2) t.re[i] = 1;
  }
  return t;
}

/**
 * A smoothly-varying stripe pattern with a *local* spatial frequency ν(x) —
 * the master element of the whole story. `phaseFn` returns the accumulated
 * stripe phase Φ(x) = 2π∫ν dx; the stripes sit at cos Φ(x).
 *
 *  - amplitude mode: t = ½(1 + m·cos Φ) — absorbing stripes (like developed film)
 *  - phase mode:     t = e^{i·(φmax/2)·cos Φ} — clear film, thickness/index stripes
 */
export function stripePattern(
  n: number,
  dx: number,
  x0: number,
  phaseFn: (x: number) => number,
  opts: { mode: "amplitude" | "phase"; contrast?: number; phiMax?: number },
): Transmission {
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const m = opts.contrast ?? 1;
  const phiMax = opts.phiMax ?? Math.PI;
  for (let i = 0; i < n; i++) {
    const c = Math.cos(phaseFn(x0 + i * dx));
    if (opts.mode === "amplitude") {
      re[i] = 0.5 * (1 + m * c);
    } else {
      const ph = (phiMax / 2) * c;
      re[i] = Math.cos(ph);
      im[i] = Math.sin(ph);
    }
  }
  return { n, dx, x0, re, im };
}

/** Uniform grating: stripes on constant pitch Λ. */
export function uniformGrating(
  n: number,
  dx: number,
  x0: number,
  opts: { pitch: number; mode: "amplitude" | "phase"; contrast?: number; phiMax?: number },
): Transmission {
  return stripePattern(n, dx, x0, (x) => (2 * Math.PI * x) / opts.pitch, opts);
}

/**
 * Linearly chirped grating: the local frequency ramps from ν₀ at the centre by
 * `chirp` per µm — each strip of the element deflects by its own angle
 * sinθ(x) = λ·ν(x), so the exit beam is a fan that tilts progressively.
 */
export function chirpedGrating(
  n: number,
  dx: number,
  x0: number,
  opts: {
    pitch0: number;
    chirp: number;
    mode: "amplitude" | "phase";
    contrast?: number;
    phiMax?: number;
  },
): Transmission {
  const nu0 = 1 / opts.pitch0;
  return stripePattern(n, dx, x0, (x) => 2 * Math.PI * (nu0 * x + (opts.chirp * x * x) / 2), opts);
}

/**
 * Fresnel zone plate with design focal length f at wavelength λ: stripes whose
 * local pitch Λ(x) = λf/|x| shrinks outward, so every strip deflects its light
 * toward the same point — a lens made of stripes. Φ(x) = π x²/(λf) (the +1st
 * order converges at f; the −1st diverges from −f; the 0th sails through).
 */
export function zonePlate(
  n: number,
  dx: number,
  x0: number,
  opts: {
    f: number;
    lambda: number;
    mode: "amplitude" | "phase";
    contrast?: number;
    phiMax?: number;
  },
): Transmission {
  return stripePattern(n, dx, x0, (x) => (Math.PI * x * x) / (opts.lambda * opts.f), opts);
}

/** Ideal thin lens: pure quadratic phase e^{−ik x²/2f} (no orders, no chroma-free
 *  pretense — f is f at every λ only because we say so; the zone plate is the
 *  honest diffractive version). */
export function idealLens(
  n: number,
  dx: number,
  x0: number,
  opts: { f: number; lambda: number },
): Transmission {
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const k = (2 * Math.PI) / opts.lambda;
  for (let i = 0; i < n; i++) {
    const x = x0 + i * dx;
    const ph = (-k * x * x) / (2 * opts.f);
    re[i] = Math.cos(ph);
    im[i] = Math.sin(ph);
  }
  return { n, dx, x0, re, im };
}

/** Hard aperture: pass only x ∈ [center−width/2, center+width/2] (multiply into
 *  any element — this is the "cut the film" scissors). */
export function apertureWindow(
  n: number,
  dx: number,
  x0: number,
  opts: { center: number; width: number },
): Transmission {
  const re = new Float64Array(n);
  const lo = opts.center - opts.width / 2;
  const hi = opts.center + opts.width / 2;
  for (let i = 0; i < n; i++) {
    const x = x0 + i * dx;
    if (x >= lo && x <= hi) re[i] = 1;
  }
  return { n, dx, x0, re, im: new Float64Array(n) };
}
