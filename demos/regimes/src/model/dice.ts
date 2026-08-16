/**
 * dice.ts — the loaded die: the smallest possible simulator that separates the
 * two prediction games (layer 1, pure).
 *
 * The generator is a six-sided die whose distribution interpolates between
 * perfectly fair (loadedness 0) and a certain ⚅ (loadedness 1). Against it we
 * score the two games the notebook keeps distinguishing:
 *
 *  - POINTWISE: call the next face. The best any observer can do is guess the
 *    modal face, and their error rate floors at 1 − max(p): at loadedness 0
 *    that is 5/6 — pointwise prediction of a fair die is hopeless.
 *  - DISTRIBUTIONAL: state the probabilities. Scored by log loss, the best
 *    achievable average is the entropy H(p) — and the fair die is the EASIEST
 *    case: "uniform" is a one-line model that sits on the floor immediately.
 *
 * Same data, opposite verdicts — the RNG paradox dissolved.
 */
import { mulberry32 } from "./rng";

export const FACES = 6;

/** Die distribution at a given loadedness L ∈ [0,1]: (1−L)·uniform + L·δ(⚅). */
export function dieDistribution(loadedness: number): number[] {
  const L = Math.min(1, Math.max(0, loadedness));
  const p = new Array(FACES).fill((1 - L) / FACES);
  p[FACES - 1] += L;
  return p;
}

/** Shannon entropy in bits — the distributional floor (best mean log loss). */
export function entropyBits(p: number[]): number {
  let h = 0;
  for (const q of p) if (q > 0) h -= q * Math.log2(q);
  return h;
}

/** Best pointwise error rate: 1 − max(p) (guess the modal face forever). */
export function pointwiseFloor(p: number[]): number {
  return 1 - Math.max(...p);
}

export interface DieRun {
  /** Faces rolled, 0-based. */
  rolls: number[];
  /** Face counts (empirical distribution × n). */
  counts: number[];
  /** Running pointwise error rate of the best guesser (knows p, guesses the mode). */
  pointwiseErr: number[];
  /** Running mean log loss (bits) of the true-distribution forecaster. */
  logLoss: number[];
}

/** Roll the die n times and score both games cumulatively. */
export function simulateDie(p: number[], n: number, seed: number): DieRun {
  const rng = mulberry32(seed);
  const mode = p.indexOf(Math.max(...p));
  const rolls: number[] = [];
  const counts = new Array(p.length).fill(0);
  const pointwiseErr: number[] = [];
  const logLoss: number[] = [];
  let errs = 0;
  let nll = 0;
  for (let i = 0; i < n; i++) {
    const u = rng();
    let acc = 0;
    let face = p.length - 1;
    for (let k = 0; k < p.length; k++) {
      acc += p[k];
      if (u < acc) {
        face = k;
        break;
      }
    }
    rolls.push(face);
    counts[face] += 1;
    if (face !== mode) errs += 1;
    nll += -Math.log2(p[face]);
    pointwiseErr.push(errs / (i + 1));
    logLoss.push(nll / (i + 1));
  }
  return { rolls, counts, pointwiseErr, logLoss };
}
