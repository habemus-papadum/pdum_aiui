/**
 * mixture.ts — the mathematics, and nothing else.
 *
 * A one-dimensional two-component Gaussian mixture: draw from it, bin it,
 * measure it, and recover its parameters with EM. Pure functions over plain
 * numbers — no Solid, no aiui, no async. Everything reactive lives in
 * graph.ts, everything visual in ui/. That split is the point: this file is
 * the part you can reason about (and unit-test) without a browser.
 */

/** The generative model: `w · N(mu1, sigma1) + (1 - w) · N(mu2, sigma2)`. */
export interface MixtureParams {
  /** Mixing weight of the first component, in [0, 1]. */
  weight: number;
  mu1: number;
  sigma1: number;
  mu2: number;
  sigma2: number;
}

/** A binned empirical density (areas sum to 1). */
export interface Histogram {
  lo: number;
  hi: number;
  /** Bin width. */
  width: number;
  /** Bin centers, one per bin. */
  centers: number[];
  /** Probability density per bin — `count / (n · width)`. */
  density: number[];
}

/** Sample moments — what the data says, ignorant of the model. */
export interface Moments {
  n: number;
  mean: number;
  sd: number;
  /** Third standardized moment; ≈0 for one symmetric Gaussian. */
  skewness: number;
  min: number;
  max: number;
}

/** One EM iteration's result. */
export interface FitStep {
  /** 1-based iteration number. */
  iter: number;
  /** The parameters *after* this iteration's update. */
  params: MixtureParams;
  /** Log-likelihood of the parameters this iteration started from. */
  logLik: number;
}

/** Never let a variance collapse onto a single point. */
const MIN_SIGMA = 1e-3;

/**
 * A small, fast, seedable PRNG (mulberry32). Deterministic given a seed, which
 * is what makes a "reseed" button meaningful and every screenshot reproducible.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One standard normal deviate (Box–Muller; the cosine branch, discard the sine). */
export function standardNormal(rand: () => number): number {
  // rand() can return exactly 0, and log(0) is -Infinity.
  const u = 1 - rand();
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Draw a single sample from the mixture. */
export function drawSample(p: MixtureParams, rand: () => number): number {
  return rand() < p.weight
    ? p.mu1 + p.sigma1 * standardNormal(rand)
    : p.mu2 + p.sigma2 * standardNormal(rand);
}

/** Normal density at `x`. */
export function normalPdf(x: number, mu: number, sigma: number): number {
  const z = (x - mu) / sigma;
  return Math.exp(-0.5 * z * z) / (sigma * Math.sqrt(2 * Math.PI));
}

/** Mixture density at `x`. */
export function mixturePdf(x: number, p: MixtureParams): number {
  return p.weight * normalPdf(x, p.mu1, p.sigma1) + (1 - p.weight) * normalPdf(x, p.mu2, p.sigma2);
}

/** Bin `data` into `bins` equal-width bins over its (slightly padded) range. */
export function buildHistogram(data: Float64Array, bins: number): Histogram {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const x of data) {
    if (x < min) min = x;
    if (x > max) max = x;
  }
  const pad = (max - min) * 0.05 || 1;
  const lo = min - pad;
  const hi = max + pad;
  const width = (hi - lo) / bins;

  const counts = new Float64Array(bins);
  for (const x of data) {
    const i = Math.min(bins - 1, Math.max(0, Math.floor((x - lo) / width)));
    counts[i] += 1;
  }

  const centers: number[] = [];
  const density: number[] = [];
  for (let i = 0; i < bins; i++) {
    centers.push(lo + (i + 0.5) * width);
    density.push(counts[i] / (data.length * width));
  }
  return { lo, hi, width, centers, density };
}

/** Sample mean, standard deviation, skewness, and range. */
export function computeMoments(data: Float64Array): Moments {
  const n = data.length;
  let sum = 0;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const x of data) {
    sum += x;
    if (x < min) min = x;
    if (x > max) max = x;
  }
  const mean = sum / n;

  let m2 = 0;
  let m3 = 0;
  for (const x of data) {
    const d = x - mean;
    m2 += d * d;
    m3 += d * d * d;
  }
  const sd = Math.sqrt(m2 / n);
  const skewness = sd > 0 ? m3 / n / (sd * sd * sd) : 0;
  return { n, mean, sd, skewness, min, max };
}

/**
 * A deliberately naive starting point for EM: split the data one standard
 * deviation either side of its mean, equal weights. It knows nothing about the
 * true parameters — watching it walk from here to the answer is the demo.
 */
export function initialGuess(m: Moments): MixtureParams {
  return {
    weight: 0.5,
    mu1: m.mean - m.sd,
    sigma1: Math.max(m.sd, MIN_SIGMA),
    mu2: m.mean + m.sd,
    sigma2: Math.max(m.sd, MIN_SIGMA),
  };
}

/**
 * One expectation–maximization iteration.
 *
 * E-step: each point's responsibility `r` toward component 1. M-step: weighted
 * means and variances. The returned `logLik` belongs to the parameters we
 * *entered* with — which is what makes a monotonically rising sequence the
 * correct thing to watch.
 */
export function emStep(data: Float64Array, p: MixtureParams): FitStep {
  const n = data.length;
  let logLik = 0;
  // Weighted sums for component 1 (r) and component 2 (1 - r).
  let sr = 0;
  let srx = 0;
  let srxx = 0;
  let sq = 0;
  let sqx = 0;
  let sqxx = 0;

  for (const x of data) {
    const a = p.weight * normalPdf(x, p.mu1, p.sigma1);
    const b = (1 - p.weight) * normalPdf(x, p.mu2, p.sigma2);
    const tot = a + b;
    // Underflow far in the tails: fall back to an uninformative split rather
    // than dividing by zero and poisoning every downstream sum with NaN.
    const r = tot > 0 ? a / tot : 0.5;
    if (tot > 0) logLik += Math.log(tot);

    const q = 1 - r;
    sr += r;
    srx += r * x;
    srxx += r * x * x;
    sq += q;
    sqx += q * x;
    sqxx += q * x * x;
  }

  const mu1 = sr > 0 ? srx / sr : p.mu1;
  const mu2 = sq > 0 ? sqx / sq : p.mu2;
  const var1 = sr > 0 ? srxx / sr - mu1 * mu1 : p.sigma1 * p.sigma1;
  const var2 = sq > 0 ? sqxx / sq - mu2 * mu2 : p.sigma2 * p.sigma2;

  return {
    iter: 0, // the caller owns iteration numbering
    logLik,
    params: {
      weight: sr / n,
      mu1,
      mu2,
      sigma1: Math.max(Math.sqrt(Math.max(var1, 0)), MIN_SIGMA),
      sigma2: Math.max(Math.sqrt(Math.max(var2, 0)), MIN_SIGMA),
    },
  };
}

/** Sample a density curve across `[lo, hi]` for plotting. */
export function densityCurve(
  lo: number,
  hi: number,
  p: MixtureParams,
  points = 240,
): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = [];
  for (let i = 0; i <= points; i++) {
    const x = lo + ((hi - lo) * i) / points;
    out.push({ x, y: mixturePdf(x, p) });
  }
  return out;
}
