/**
 * regress.ts — one honest simulator and everything the notebook measures on it
 * (layer 1, pure).
 *
 * The generator is y = f(x) + σ·ε on x ∈ [−1, 1], with f a fixed smooth truth
 * carrying both a coarse and a fine wiggle — so low-degree polynomial families
 * genuinely cannot express it (approximation error is real, not cosmetic).
 *
 * On top of it: Chebyshev least-squares fitting (the exact solver keeps the
 * optimization term at zero on purpose — gradient descent gets its own section),
 * the best-in-family curve (infinite clean data), the Monte-Carlo four-term
 * decomposition
 *
 *     expected test MSE = noise floor + approximation + estimation (+ 0)
 *
 * measured by refitting on many independent draws, and the ensembling/
 * disagreement machinery: average M refits and only the estimation term shrinks.
 */
import { gaussian, mulberry32 } from "./rng";

/** The truth: a coarse wave plus a fine wiggle. A Chebyshev fit of sin(ax)
 * needs degree ≈ a before its coefficients die off, so the 4πx term keeps
 * every family below degree ≈ 12 honestly unable to express f. */
export function trueF(x: number): number {
  return Math.sin(2 * Math.PI * x) + 0.4 * Math.sin(4 * Math.PI * x);
}

/** Var over x~U(−1,1) of f(x): the "signal" — structure available to any model. */
export function signalVariance(gridN = 512): number {
  let s = 0;
  let s2 = 0;
  for (let i = 0; i < gridN; i++) {
    const x = -1 + (2 * (i + 0.5)) / gridN;
    const v = trueF(x);
    s += v;
    s2 += v * v;
  }
  const mean = s / gridN;
  return s2 / gridN - mean * mean;
}

export interface Dataset {
  xs: number[];
  ys: number[];
}

/** Draw n samples of the simulator at noise level sigma. */
export function makeDataset(n: number, sigma: number, seed: number): Dataset {
  const rng = mulberry32(seed);
  const g = gaussian(mulberry32(seed ^ 0x9e3779b9));
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < n; i++) {
    const x = -1 + 2 * rng();
    xs.push(x);
    ys.push(trueF(x) + sigma * g());
  }
  return { xs, ys };
}

// --- Chebyshev least squares -------------------------------------------------

/** Chebyshev basis values T_0..T_deg at x (stable recurrence). */
function chebRow(x: number, degree: number): number[] {
  const row = new Array(degree + 1);
  row[0] = 1;
  if (degree >= 1) row[1] = x;
  for (let k = 2; k <= degree; k++) row[k] = 2 * x * row[k - 1] - row[k - 2];
  return row;
}

/** Solve the symmetric system A·c = b by Gaussian elimination w/ partial pivoting. */
function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    [M[col], M[piv]] = [M[piv], M[col]];
    const d = M[col][col];
    for (let r = col + 1; r < n; r++) {
      const factor = M[r][col] / d;
      for (let c = col; c <= n; c++) M[r][c] -= factor * M[col][c];
    }
  }
  const c = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let acc = M[r][n];
    for (let k = r + 1; k < n; k++) acc -= M[r][k] * c[k];
    c[r] = acc / M[r][r];
  }
  return c;
}

/** Least-squares Chebyshev fit of degree `degree` (tiny ridge for conditioning). */
export function polyfit(data: Dataset, degree: number): number[] {
  const m = degree + 1;
  const A = Array.from({ length: m }, () => new Array(m).fill(0));
  const b = new Array(m).fill(0);
  for (let i = 0; i < data.xs.length; i++) {
    const row = chebRow(data.xs[i], degree);
    for (let r = 0; r < m; r++) {
      b[r] += row[r] * data.ys[i];
      for (let c = r; c < m; c++) A[r][c] += row[r] * row[c];
    }
  }
  for (let r = 0; r < m; r++) {
    for (let c = 0; c < r; c++) A[r][c] = A[c][r];
    A[r][r] += 1e-9 * Math.max(1, data.xs.length);
  }
  return solve(A, b);
}

/** Evaluate a Chebyshev coefficient vector at x. */
export function polyEval(coef: number[], x: number): number {
  const row = chebRow(x, coef.length - 1);
  let s = 0;
  for (let k = 0; k < coef.length; k++) s += coef[k] * row[k];
  return s;
}

/** The evaluation grid every curve and expectation in this module uses. */
export function grid(gridN = 161): number[] {
  return Array.from({ length: gridN }, (_, i) => -1 + (2 * i) / (gridN - 1));
}

/** Best-in-family: the degree-d fit to abundant CLEAN data — what the family
 * could express if estimation were free. Its gap to f is approximation error. */
export function bestInFamily(degree: number, gridN = 321): number[] {
  const xs = grid(gridN);
  return polyfit({ xs, ys: xs.map(trueF) }, degree);
}

// --- the four-term decomposition --------------------------------------------

export interface Decomposition {
  /** σ²: the injected randomness no model removes. */
  floor: number;
  /** Grid-mean (best-in-family − f)²: the family cannot express the truth. */
  approximation: number;
  /** Grid-mean variance of the fit across refits: finite data wobble. */
  estimation: number;
  /** Zero here by construction (exact solver); gradient descent owns §5. */
  optimization: number;
  /** floor + approximation + estimation: the expected test MSE. */
  total: number;
  /** Which term dominates the excess (above the floor). */
  dominant: "approximation" | "estimation" | "balanced";
  x: number[];
  fTrue: number[];
  best: number[];
  meanFit: number[];
  /** A handful of individual refits — the visible wobble. */
  sampleFits: number[][];
}

export interface DecompParams {
  degree: number;
  n: number;
  sigma: number;
  trials: number;
  seed: number;
}

/** Monte-Carlo decomposition: refit on `trials` independent datasets and
 * average over the grid. Estimation is measured about the best-in-family curve
 * so approximation + estimation tiles the excess exactly in expectation. */
export function decompose(p: DecompParams): Decomposition {
  const x = grid();
  const fTrue = x.map(trueF);
  const bestCoef = bestInFamily(p.degree);
  const best = x.map((xx) => polyEval(bestCoef, xx));

  const fits: number[][] = [];
  for (let t = 0; t < p.trials; t++) {
    const coef = polyfit(makeDataset(p.n, p.sigma, p.seed + 7919 * t), p.degree);
    fits.push(x.map((xx) => polyEval(coef, xx)));
  }

  const meanFit = x.map((_, i) => fits.reduce((s, f) => s + f[i], 0) / fits.length);
  let approximation = 0;
  let estimation = 0;
  for (let i = 0; i < x.length; i++) {
    const a = best[i] - fTrue[i];
    approximation += a * a;
    let v = 0;
    for (const f of fits) {
      const d = f[i] - best[i];
      v += d * d;
    }
    estimation += v / fits.length;
  }
  approximation /= x.length;
  estimation /= x.length;

  const floor = p.sigma * p.sigma;
  const total = floor + approximation + estimation;
  const ratio = approximation / Math.max(1e-12, estimation);
  const dominant: Decomposition["dominant"] =
    ratio > 3 ? "approximation" : ratio < 1 / 3 ? "estimation" : "balanced";

  return {
    floor,
    approximation,
    estimation,
    optimization: 0,
    total,
    dominant,
    x,
    fTrue,
    best,
    meanFit,
    sampleFits: fits.slice(0, 12),
  };
}

// --- ensembling ---------------------------------------------------------------

export interface EnsembleResult {
  /** Test MSE (vs the noiseless truth, grid-mean) after averaging M members. */
  mseByM: number[];
  /** Grid-mean variance across members: the truth-free disagreement gauge. */
  disagreement: number;
  /** The ensemble-mean curve at M = max. */
  ensembleCurve: number[];
  x: number[];
}

export interface EnsembleParams {
  degree: number;
  n: number;
  sigma: number;
  maxM: number;
  seed: number;
  /** Vary the family across members (degree − 2 … degree + 2) instead of clones. */
  heterogeneous: boolean;
}

/** Average M independent refits for M = 1…maxM. In the estimation-limited
 * regime the excess shrinks like 1/M; when approximation dominates the curve
 * goes flat — averaging cannot express what no member can. */
export function ensemble(p: EnsembleParams): EnsembleResult {
  const x = grid();
  const fTrue = x.map(trueF);
  const members: number[][] = [];
  for (let m = 0; m < p.maxM; m++) {
    const deg = p.heterogeneous ? Math.max(1, p.degree - 2 + (m % 5)) : p.degree;
    const coef = polyfit(makeDataset(p.n, p.sigma, p.seed + 104729 * (m + 1)), deg);
    members.push(x.map((xx) => polyEval(coef, xx)));
  }

  const mseByM: number[] = [];
  const acc = new Array(x.length).fill(0);
  for (let m = 0; m < p.maxM; m++) {
    for (let i = 0; i < x.length; i++) acc[i] += members[m][i];
    let mse = 0;
    for (let i = 0; i < x.length; i++) {
      const d = acc[i] / (m + 1) - fTrue[i];
      mse += d * d;
    }
    mseByM.push(mse / x.length);
  }

  const mean = acc.map((s) => s / p.maxM);
  let disagreement = 0;
  for (let i = 0; i < x.length; i++) {
    let v = 0;
    for (const f of members) {
      const d = f[i] - mean[i];
      v += d * d;
    }
    disagreement += v / members.length;
  }
  disagreement /= x.length;

  return { mseByM, disagreement, ensembleCurve: mean, x };
}
