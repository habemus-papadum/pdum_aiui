/**
 * training.ts — a FAKE policy-gradient run, pure and deterministic: the four
 * terms of a PPO-style objective as they might evolve over a run, and, per
 * step, a simulated BATCH behind the clipped surrogate — the ratios r_t and
 * advantages Â_t that decide, sample by sample, which argument the min takes
 * and which bound of the clip did the clipping. Nothing is trained; the
 * shapes are chosen to make the equation worth watching, and the batch makes
 * PPO's real diagnostic (the clip fraction) visible on the terms that cause
 * it. Deterministic in `step` (hash noise, no RNG), so a reset replays the
 * same run and a test can pin a number.
 *
 * The parameters are the equation's symbols — ε, β, c_v, c_H — and every one
 * can change mid-run (the knobs in the equation), so a step is a function of
 * (step index, params), never of history.
 */

export const TERM_IDS = ["policy", "value", "entropy", "kl"] as const;
export type TermId = (typeof TERM_IDS)[number];

export const TERM_LABELS: Record<TermId, string> = {
  policy: "clipped surrogate",
  value: "value error",
  entropy: "entropy bonus",
  kl: "KL penalty",
};

export interface TrainParams {
  /** The KL coefficient β. */
  beta: number;
  /** The clip half-width ε: the band is [1 − ε, 1 + ε]. */
  epsilon: number;
  /** The value-error coefficient c_v. */
  cv: number;
  /** The entropy-bonus coefficient c_H. */
  ch: number;
}

export const DEFAULT_PARAMS: TrainParams = { beta: 0.1, epsilon: 0.2, cv: 0.5, ch: 0.05 };

/** Samples per step in the simulated batch. */
export const BATCH = 48;

/** The batch behind the clipped surrogate, as fractions of the batch. */
export interface ClipStats {
  /** Ratios below 1 − ε. */
  low: number;
  /** Ratios inside the band. */
  inBand: number;
  /** Ratios above 1 + ε. */
  high: number;
  /**
   * Samples where the min took the CLIPPED argument — a positive advantage
   * above the band, or a negative one below it — so the sample contributes
   * no gradient. PPO's logged `clipfrac`. Inside the band the two arguments
   * coincide; that counts as unclipped (the gradient flows).
   */
  clipped: number;
  /** …of which the lower bound did it (negative advantage, ratio below). */
  clippedLow: number;
  /** …of which the upper bound did it (positive advantage, ratio above). */
  clippedHigh: number;
  /** The log-ratio spread this step — how far the policy moved. */
  sigma: number;
}

export interface TrainStep {
  step: number;
  /** The clipped surrogate E[min(r·Â, clip(r)·Â)] — the thing being maximized. */
  policy: number;
  /** The squared value error (V − R)². */
  value: number;
  /** The policy entropy H[π]. */
  entropy: number;
  /** D_KL(π_θ ‖ π_ref). */
  kl: number;
  /** The total loss with the coefficients applied. */
  loss: number;
  clip: ClipStats;
  /** The batch's ratios r_t, for the histogram. */
  ratios: number[];
  /** The batch's advantages Â_t, paired with `ratios`. */
  advantages: number[];
}

/** Hash noise in [-1, 1], a different stream per `k`. */
export function hashNoise(step: number, k: number): number {
  const x = Math.sin(step * 12.9898 + k * 78.233) * 43758.5453;
  return (x - Math.floor(x)) * 2 - 1;
}

/** A standard normal draw, deterministic in (step, i, k): Box–Muller over two hash uniforms. */
function gauss(step: number, i: number, k: number): number {
  const u1 = Math.min(0.999999, Math.max(1e-6, (hashNoise(step * 131 + i, k) + 1) / 2));
  const u2 = (hashNoise(step * 131 + i, k + 1) + 1) / 2;
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

export function initialStep(p: TrainParams = DEFAULT_PARAMS): TrainStep {
  return evolve(0, p);
}

/**
 * The batch of one step. The log-ratio spread starts wide and settles as the
 * run does, and a larger β — a policy held closer to its reference — moves
 * less per update; a small drift keeps the two sides of the band uneven.
 */
export function sampleBatch(
  step: number,
  p: TrainParams,
): Pick<TrainStep, "ratios" | "advantages" | "clip"> {
  const sigma = (0.05 + 0.3 * Math.exp(-step / 320)) / (1 + 2 * p.beta);
  const mu = 0.03 * hashNoise(step, 5);
  const ratios: number[] = [];
  const advantages: number[] = [];
  let low = 0;
  let high = 0;
  let clippedLow = 0;
  let clippedHigh = 0;
  for (let i = 0; i < BATCH; i++) {
    const r = Math.exp(mu + sigma * gauss(step, i, 10));
    const a = gauss(step, i, 20);
    ratios.push(r);
    advantages.push(a);
    if (r < 1 - p.epsilon) {
      low++;
      if (a < 0) clippedLow++;
    } else if (r > 1 + p.epsilon) {
      high++;
      if (a > 0) clippedHigh++;
    }
  }
  return {
    ratios,
    advantages,
    clip: {
      low: low / BATCH,
      inBand: (BATCH - low - high) / BATCH,
      high: high / BATCH,
      clipped: (clippedLow + clippedHigh) / BATCH,
      clippedLow: clippedLow / BATCH,
      clippedHigh: clippedHigh / BATCH,
      sigma,
    },
  };
}

function evolve(step: number, p: TrainParams): TrainStep {
  const policy = 0.08 + 0.9 * Math.exp(-step / 350) + 0.03 * hashNoise(step, 1);
  const value = 0.05 + 0.55 * Math.exp(-step / 220) + 0.02 * hashNoise(step, 2);
  const entropy = 0.35 + 1.25 * Math.exp(-step / 600) + 0.02 * hashNoise(step, 3);
  // The policy drifts from the reference; β pulls the equilibrium down.
  const klTarget = 2 / (1 + 6 * p.beta);
  const kl = Math.max(0, klTarget * (1 - Math.exp(-step / 180)) * (1 + 0.08 * hashNoise(step, 4)));
  const loss = -policy + p.cv * value - p.ch * entropy + p.beta * kl;
  return { step, policy, value, entropy, kl, loss, ...sampleBatch(step, p) };
}

/** The next step of the run. */
export function stepTraining(prev: TrainStep, p: TrainParams): TrainStep {
  return evolve(prev.step + 1, p);
}

export interface TermMagnitude {
  /** The term's contribution to the loss, coefficient applied, as a magnitude. */
  value: number;
  /** Its share of the sum of all four magnitudes, in [0, 1]. */
  share: number;
}

/** Each term as it enters the loss — |coefficient × quantity| — and its share. */
export function termMagnitudes(t: TrainStep, p: TrainParams): Record<TermId, TermMagnitude> {
  const raw: Record<TermId, number> = {
    policy: Math.abs(t.policy),
    value: Math.abs(p.cv * t.value),
    entropy: Math.abs(p.ch * t.entropy),
    kl: Math.abs(p.beta * t.kl),
  };
  const total = TERM_IDS.reduce((s, id) => s + raw[id], 0);
  const out = {} as Record<TermId, TermMagnitude>;
  for (const id of TERM_IDS) out[id] = { value: raw[id], share: total > 0 ? raw[id] / total : 0 };
  return out;
}

/** The clip fractions over a run: one row per step, and their means — the
 * "running" statistics the notes show beside the instantaneous ones. */
export interface ClipRow {
  step: number;
  low: number;
  inBand: number;
  high: number;
  clipped: number;
}
export type ClipMeans = Omit<ClipStats, "sigma">;

export function clipSummary(history: readonly TrainStep[]): { rows: ClipRow[]; mean: ClipMeans } {
  const rows: ClipRow[] = [];
  const sum: ClipMeans = { low: 0, inBand: 0, high: 0, clipped: 0, clippedLow: 0, clippedHigh: 0 };
  for (const t of history) {
    const c = t.clip;
    rows.push({ step: t.step, low: c.low, inBand: c.inBand, high: c.high, clipped: c.clipped });
    sum.low += c.low;
    sum.inBand += c.inBand;
    sum.high += c.high;
    sum.clipped += c.clipped;
    sum.clippedLow += c.clippedLow;
    sum.clippedHigh += c.clippedHigh;
  }
  const n = Math.max(1, history.length);
  const mean: ClipMeans = {
    low: sum.low / n,
    inBand: sum.inBand / n,
    high: sum.high / n,
    clipped: sum.clipped / n,
    clippedLow: sum.clippedLow / n,
    clippedHigh: sum.clippedHigh / n,
  };
  return { rows, mean };
}
