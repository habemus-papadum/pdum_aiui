/**
 * Small numeric toolkit: smoothing, spectra, and descriptive statistics over
 * plain `number[]` / `Float64Array` data.
 *
 * {@link summary} is consumed by {@link describeSignal} here and by the
 * `Pipeline` in `pipeline.ts`, so this module is a shared leaf that several
 * files reference. It mirrors the Python `signals.py` + `stats.py` fixtures.
 */

/** Anything this module can treat as a 1-D sequence of floats. */
export type ArrayLike = readonly number[] | Float64Array;

/** A compact statistical description of a 1-D dataset. */
export interface Summary {
  /** Number of samples. */
  readonly count: number;
  /** Arithmetic mean. */
  readonly mean: number;
  /** Population standard deviation. */
  readonly std: number;
  /** Smallest value. */
  readonly min: number;
  /** Largest value. */
  readonly max: number;
  /** 25th percentile. */
  readonly p25: number;
  /** 50th percentile (median). */
  readonly p50: number;
  /** 75th percentile. */
  readonly p75: number;
}

/** Copy `signal` into a fresh `number[]`, accepting arrays or typed arrays. */
function toArray(signal: ArrayLike): number[] {
  return Array.from(signal);
}

/**
 * Smooth `signal` with a centered box filter of size `window`.
 *
 * Returns an array the same length as the input; edges are handled by clamping
 * the averaging range to the available samples.
 */
export function movingAverage(signal: ArrayLike, window: number): number[] {
  const arr = toArray(signal);
  if (window < 1 || !Number.isInteger(window)) {
    throw new RangeError("window must be a positive integer");
  }
  if (window === 1) {
    return arr.slice();
  }
  const half = Math.floor(window / 2);
  const out: number[] = new Array<number>(arr.length);
  for (let i = 0; i < arr.length; i++) {
    const lo = Math.max(0, i - half);
    const hi = Math.min(arr.length - 1, i + half);
    let acc = 0;
    for (let j = lo; j <= hi; j++) {
      acc += arr[j];
    }
    out[i] = acc / (hi - lo + 1);
  }
  return out;
}

/**
 * Magnitude spectrum of a real `signal` (stub, not a real FFT).
 *
 * A faithful FFT is out of scope for this fixture; this computes the magnitude
 * of a naive one-sided DFT so downstream code has a plausibly-shaped spectrum
 * to consume. Complexity is O(n^2), which is fine for the small demo inputs.
 */
export function fftMagnitude(signal: ArrayLike): number[] {
  const arr = toArray(signal);
  const n = arr.length;
  const bins = Math.floor(n / 2) + 1;
  const out: number[] = new Array<number>(bins);
  for (let k = 0; k < bins; k++) {
    let re = 0;
    let im = 0;
    for (let t = 0; t < n; t++) {
      const angle = (-2 * Math.PI * k * t) / n;
      re += arr[t] * Math.cos(angle);
      im += arr[t] * Math.sin(angle);
    }
    out[k] = Math.hypot(re, im);
  }
  return out;
}

/** Linear-interpolation percentile of a *sorted* ascending array. */
function percentile(sorted: readonly number[], q: number): number {
  if (sorted.length === 1) {
    return sorted[0];
  }
  const pos = (q / 100) * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) {
    return sorted[lo];
  }
  const frac = pos - lo;
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}

/** Compute mean/std/percentiles for `data` and return a {@link Summary}. */
export function summary(data: ArrayLike): Summary {
  const arr = toArray(data);
  if (arr.length === 0) {
    throw new RangeError("cannot summarize an empty dataset");
  }
  const count = arr.length;
  const mean = arr.reduce((acc, x) => acc + x, 0) / count;
  const variance = arr.reduce((acc, x) => acc + (x - mean) ** 2, 0) / count;
  const sorted = arr.slice().sort((a, b) => a - b);
  return {
    count,
    mean,
    std: Math.sqrt(variance),
    min: sorted[0],
    max: sorted[count - 1],
    p25: percentile(sorted, 25),
    p50: percentile(sorted, 50),
    p75: percentile(sorted, 75),
  };
}

/**
 * Summarize a signal's amplitude distribution.
 *
 * A thin wrapper that delegates to {@link summary}; kept as its own function so
 * `pipeline.ts` has a descriptively-named cross-file reference target.
 */
export function describeSignal(signal: ArrayLike): Summary {
  return summary(signal);
}

/** Generate a noisy sine wave, a convenient input for the helpers above. */
export function sineWave(
  freq: number,
  duration = 1.0,
  sampleRate = 256,
  noise = 0.0,
  seed = 1,
): number[] {
  const n = Math.floor(duration * sampleRate);
  const rng = mulberry32(seed);
  const out: number[] = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    let sample = Math.sin(2 * Math.PI * freq * t);
    if (noise > 0) {
      // Cheap uniform jitter in [-noise, +noise]; deterministic given `seed`.
      sample += noise * (rng() * 2 - 1);
    }
    out[i] = sample;
  }
  return out;
}

/** Tiny deterministic PRNG (mulberry32) so `sineWave` noise is reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
