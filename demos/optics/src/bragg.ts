/**
 * bragg.ts — volume (thick-emulsion) holograms: why a Denisyuk reflection
 * hologram picks its own color out of white light.
 *
 * In a THIN hologram the fringes are stripes ON a surface, and every λ
 * diffracts (each to its own angle — the white-light smear). In a THICK
 * emulsion recorded with counter-propagating beams, the fringes are LAYERS —
 * planes of altered refractive index stacked ~λ/2n apart through the depth.
 * Reflections from successive layers add in phase only for the wavelength
 * that matches the stack (the Bragg condition λ_B = 2·n·Λ·cosθ): the film is
 * a wavelength-selective mirror. More layers → narrower selection; stronger
 * index modulation → deeper reflection. That single mechanism is why museum
 * holograms work under a desk lamp, why processing shrinkage green-shifts
 * them, why they turn blue as you tilt them — and how AR-waveguide combiners
 * steer one λ while passing the rest of the world.
 *
 * Computed honestly with the classic characteristic-matrix method (Born &
 * Wolf / Macleod): the sinusoidal index profile n(z) = n₀ + Δn·cos(2πz/Λ) is
 * sliced thin, each slice contributes its 2×2 matrix, and the stack's
 * reflectance follows. Oblique viewing is folded in via the internal angle
 * (Λ_eff = Λ·cosθ_inside) — the standard thick-grating bookkeeping.
 */

export interface BraggParams {
  /** Recording wavelength (in-simulation µm) — sets the layer spacing
   *  Λ = λ_rec/(2n₀), the counter-propagating recording geometry. */
  lambdaRec: number;
  /** Mean emulsion index n₀ (gelatin ≈ 1.5). */
  n0?: number;
  /** Peak index modulation Δn (silver-halide ≈ 0.01–0.05 after processing). */
  deltaN: number;
  /** Emulsion thickness, in fringe periods (layers). */
  periods: number;
  /** Fractional thickness change in processing (−0.1 = 10% shrinkage). */
  shrink?: number;
  /** Viewing tilt from the normal, degrees (in air). */
  tiltDeg?: number;
  /** Slices per period for the matrix integration. */
  slicesPerPeriod?: number;
}

/** Reflectance of the stack at one (vacuum) wavelength. */
export function braggReflectance(p: BraggParams, lambda: number): number {
  const n0 = p.n0 ?? 1.5;
  const shrink = p.shrink ?? 0;
  const slices = p.slicesPerPeriod ?? 10;

  // internal angle (Snell), and the effective period seen along the ray
  const sinIn = Math.sin(((p.tiltDeg ?? 0) * Math.PI) / 180) / n0;
  const cosIn = Math.sqrt(Math.max(0, 1 - sinIn * sinIn));

  const period = (p.lambdaRec / (2 * n0)) * (1 + shrink) * cosIn;
  const dz = period / slices;
  const total = Math.round(p.periods * slices);

  // characteristic matrix M = Π slices; each slice: homogeneous layer
  //   [[cos δ, i sin δ / n], [i n sin δ, cos δ]],  δ = 2π n dz / λ
  // (complex 2×2, but every entry is either purely real or purely imaginary,
  //  so track M = A + iB with real A, B)
  let m11r = 1;
  let m11i = 0;
  let m12r = 0;
  let m12i = 0;
  let m21r = 0;
  let m21i = 0;
  let m22r = 1;
  let m22i = 0;
  for (let s = 0; s < total; s++) {
    const z = (s + 0.5) * dz;
    const n = n0 + p.deltaN * Math.cos((2 * Math.PI * z) / period);
    const delta = (2 * Math.PI * n * dz) / lambda;
    const c = Math.cos(delta);
    const si = Math.sin(delta);
    const l11 = c;
    const l12i = si / n; // ·i
    const l21i = si * n; // ·i
    const l22 = c;
    // M ← M · L (complex product with L's structure)
    const a11r = m11r * l11 - m12i * l21i;
    const a11i = m11i * l11 + m12r * l21i;
    const a12r = -m11i * l12i + m12r * l22;
    const a12i = m11r * l12i + m12i * l22;
    const a21r = m21r * l11 - m22i * l21i;
    const a21i = m21i * l11 + m22r * l21i;
    const a22r = -m21i * l12i + m22r * l22;
    const a22i = m21r * l12i + m22i * l22;
    m11r = a11r;
    m11i = a11i;
    m12r = a12r;
    m12i = a12i;
    m21r = a21r;
    m21i = a21i;
    m22r = a22r;
    m22i = a22i;
  }

  // r = (η₀B − C)/(η₀B + C), B = M11 + M12·ηs, C = M21 + M22·ηs
  // both bounding media = the emulsion base n₀ (the grating floats inside)
  const eta = n0;
  const bR = m11r + m12r * eta;
  const bI = m11i + m12i * eta;
  const cR = m21r + m22r * eta;
  const cI = m21i + m22i * eta;
  const numR = eta * bR - cR;
  const numI = eta * bI - cI;
  const denR = eta * bR + cR;
  const denI = eta * bI + cI;
  const den2 = denR * denR + denI * denI;
  return den2 > 0 ? (numR * numR + numI * numI) / den2 : 0;
}

export interface BraggCurve {
  lambdas: Float64Array;
  reflect: Float64Array;
  peakLambda: number;
  peakR: number;
  /** Full width at half of the peak reflectance, µm. */
  fwhm: number;
}

/** Reflectance across a wavelength band (the white-light illumination). */
export function braggCurve(
  p: BraggParams,
  band: readonly [number, number],
  samples = 220,
): BraggCurve {
  const lambdas = new Float64Array(samples);
  const reflect = new Float64Array(samples);
  let peakR = 0;
  let peakLambda = band[0];
  for (let i = 0; i < samples; i++) {
    const l = band[0] + ((i + 0.5) / samples) * (band[1] - band[0]);
    lambdas[i] = l;
    reflect[i] = braggReflectance(p, l);
    if (reflect[i] > peakR) {
      peakR = reflect[i];
      peakLambda = l;
    }
  }
  // FWHM around the peak
  const half = peakR / 2;
  let lo = peakLambda;
  let hi = peakLambda;
  const step = (band[1] - band[0]) / samples;
  for (let i = 0; i < samples; i++) {
    if (reflect[i] >= half) {
      lo = Math.min(lo, lambdas[i]);
      hi = Math.max(hi, lambdas[i]);
    }
  }
  return { lambdas, reflect, peakLambda, peakR, fwhm: peakR > 0 ? hi - lo + step : 0 };
}
