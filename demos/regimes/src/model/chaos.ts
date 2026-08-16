/**
 * chaos.ts — the logistic map at r = 4: a five-character program whose
 * pointwise predictability dies exponentially while its statistics live forever
 * (layer 1, pure).
 *
 * x_{n+1} = 4·x·(1−x). Its Lyapunov exponent is exactly ln 2: a state error ε
 * grows like ε·2^n, so pointwise SNR decays exponentially in the horizon. Yet
 * the invariant (long-run occupancy) density is known in closed form — the
 * arcsine law 1/(π√(x(1−x))) — and a histogram of any typical trajectory
 * converges to it. Same simulator, opposite fates for the two games of §1.
 */
import { mulberry32 } from "./rng";

export const LYAPUNOV = Math.log(2);

/** One step of the logistic map at r = 4. */
export function step(x: number): number {
  return 4 * x * (1 - x);
}

export interface DivergenceResult {
  /** Horizon n = 0 … horizon. */
  n: number[];
  /** Mean |x_n − x'_n| over many starts (perturbed by ε at n = 0). */
  meanErr: number[];
  /** The Lyapunov prediction ε·e^(λn), capped at the saturation level. */
  predicted: number[];
  /** Steps until the error reaches ~10% of saturation: the predictability horizon. */
  horizonSteps: number;
}

/** Average divergence of ε-separated trajectory pairs. */
export function divergence(
  eps: number,
  horizon: number,
  nStarts: number,
  seed: number,
): DivergenceResult {
  const rng = mulberry32(seed);
  const sum = new Array(horizon + 1).fill(0);
  for (let s = 0; s < nStarts; s++) {
    let a = 0.05 + 0.9 * rng();
    let b = Math.min(1, Math.max(0, a + eps));
    for (let i = 0; i <= horizon; i++) {
      sum[i] += Math.abs(a - b);
      a = step(a);
      b = step(b);
    }
  }
  const meanErr = sum.map((v) => v / nStarts);
  const saturation = 0.365; // mean |x − x'| for independent arcsine-distributed pairs
  const n = Array.from({ length: horizon + 1 }, (_, i) => i);
  const predicted = n.map((i) => Math.min(saturation, eps * Math.exp(LYAPUNOV * i)));
  const tol = saturation * 0.1;
  let horizonSteps = horizon;
  for (let i = 0; i <= horizon; i++) {
    if (meanErr[i] >= tol) {
      horizonSteps = i;
      break;
    }
  }
  return { n, meanErr, predicted, horizonSteps };
}

export interface InvariantResult {
  /** Bin centers on (0, 1). */
  centers: number[];
  /** Empirical occupancy density of one trajectory. */
  density: number[];
  /** The arcsine law 1/(π√(x(1−x))) at the centers. */
  arcsine: number[];
}

/** Occupancy histogram of one long trajectory vs the closed-form invariant. */
export function invariantHistogram(steps: number, bins: number, seed: number): InvariantResult {
  const rng = mulberry32(seed);
  let x = 0.05 + 0.9 * rng();
  for (let i = 0; i < 100; i++) x = step(x); // burn-in
  const counts = new Array(bins).fill(0);
  for (let i = 0; i < steps; i++) {
    const b = Math.min(bins - 1, Math.floor(x * bins));
    counts[b] += 1;
    x = step(x);
  }
  const centers: number[] = [];
  const density: number[] = [];
  const arcsine: number[] = [];
  for (let b = 0; b < bins; b++) {
    const c = (b + 0.5) / bins;
    centers.push(c);
    density.push((counts[b] / steps) * bins);
    arcsine.push(1 / (Math.PI * Math.sqrt(c * (1 - c))));
  }
  return { centers, density, arcsine };
}

/** Two trajectories from ε-separated starts (the visible fraying pair). */
export function trajectoryPair(
  x0: number,
  eps: number,
  horizon: number,
): { n: number[]; a: number[]; b: number[] } {
  const n: number[] = [];
  const a: number[] = [];
  const b: number[] = [];
  let xa = x0;
  let xb = Math.min(1, Math.max(0, x0 + eps));
  for (let i = 0; i <= horizon; i++) {
    n.push(i);
    a.push(xa);
    b.push(xb);
    xa = step(xa);
    xb = step(xb);
  }
  return { n, a, b };
}
