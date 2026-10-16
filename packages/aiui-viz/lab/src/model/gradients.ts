/**
 * gradients.ts — a SYNTHETIC gradient view of the objective, pure and
 * deterministic, at the altitude a practitioner reads it: not coordinates in
 * θ, but the RELATIONS between the per-term gradients g_k = ∇_θ L_k.
 *
 *   - `norm`      ‖c_k g_k‖ — how hard the term pulls (coefficient applied);
 *   - `align`     cos(g_k, g_total) — does the term help the step or fight it;
 *   - `stability` cos(g_k(t), g_k(t−1)) — does it point the same way twice;
 *   - `cos`       the pairwise matrix — which terms conflict;
 *   - `byGroup`   how the term's norm distributes over the parameter groups
 *                 (the architecture axis, as an ordered list of groups).
 *
 * What is invented here is the pairwise geometry (the KL penalty's gradient
 * opposes the policy gradient more as the policy drifts; the entropy bonus
 * mildly opposes it; the value head is nearly orthogonal to all of them) and
 * the group profiles. What is DERIVED is `align` and `total`: given norms
 * and pairwise cosines, cos(g_k, Σ_j g_j) = Σ_j n_j C_kj / ‖Σ_j g_j‖ — so the
 * alignment arithmetic is honest to the geometry it is handed, and the test
 * pins the identity Σ_k n_k·align_k = ‖g_total‖. A real system would log
 * these from one backward pass per term at a sampling cadence; the shapes
 * here are only plausible.
 */
import {
  hashNoise,
  TERM_IDS,
  type TermId,
  type TrainParams,
  type TrainStep,
  termMagnitudes,
} from "./training";

export const GROUPS = [
  "embed",
  "block 1",
  "block 2",
  "block 3",
  "block 4",
  "policy head",
  "value head",
] as const;
export type GroupId = (typeof GROUPS)[number];

export interface TermGradient {
  norm: number;
  align: number;
  stability: number;
  /** Fractions over `GROUPS`, summing to one. */
  byGroup: number[];
}

export interface GradientView {
  terms: Record<TermId, TermGradient>;
  /** Pairwise cosines in `TERM_IDS` order (symmetric, unit diagonal). */
  cos: number[][];
  /** ‖g_total‖. */
  total: number;
}

/** Where each term's gradient lands, nominally (the jitter is per step). */
const PROFILE: Record<TermId, readonly number[]> = {
  policy: [0.04, 0.08, 0.14, 0.22, 0.26, 0.26, 0],
  value: [0.03, 0.06, 0.1, 0.18, 0.23, 0, 0.4],
  entropy: [0.03, 0.07, 0.13, 0.22, 0.27, 0.28, 0],
  kl: [0.02, 0.05, 0.1, 0.2, 0.3, 0.33, 0],
};

const clamp1 = (x: number): number => Math.max(-1, Math.min(1, x));

/** The pairwise cosine between two terms at this step. */
function pairCos(a: TermId, b: TermId, t: TrainStep, k: number): number {
  if (a === b) return 1;
  const pair = [a, b].sort().join("|");
  const n = hashNoise(t.step, 40 + k);
  switch (pair) {
    case "kl|policy":
      // The penalty pulls back toward the reference, against the policy
      // gradient, the more the policy has drifted.
      return clamp1(-(0.25 + 0.6 * Math.min(1, t.kl)) + 0.05 * n);
    case "entropy|policy":
      return clamp1(-0.2 + 0.08 * n);
    case "policy|value":
      return clamp1(0.08 + 0.08 * n);
    case "entropy|kl":
      return clamp1(-0.12 + 0.05 * n);
    default:
      return clamp1(0.03 * n); // value against entropy or kl: nearly orthogonal
  }
}

export function gradientView(t: TrainStep, p: TrainParams): GradientView {
  const m = termMagnitudes(t, p);
  // Clipped samples contribute no surrogate gradient.
  const norms: Record<TermId, number> = {
    policy: 0.9 * m.policy.value * (1 - t.clip.clipped) * (1 + 0.08 * hashNoise(t.step, 31)),
    value: 1.4 * m.value.value * (1 + 0.05 * hashNoise(t.step, 32)),
    entropy: 0.7 * m.entropy.value * (1 + 0.05 * hashNoise(t.step, 33)),
    kl: 1.1 * m.kl.value * (1 + 0.05 * hashNoise(t.step, 34)),
  };
  // One noise stream per unordered pair, so the matrix is exactly symmetric.
  const cos = TERM_IDS.map((a, i) =>
    TERM_IDS.map((b, j) => pairCos(a, b, t, Math.min(i, j) * 4 + Math.max(i, j))),
  );
  // ‖Σ g‖² = Σ_i Σ_j n_i n_j C_ij
  let total2 = 0;
  TERM_IDS.forEach((a, i) => {
    TERM_IDS.forEach((b, j) => {
      total2 += norms[a] * norms[b] * (cos[i]?.[j] ?? 0);
    });
  });
  const total = Math.sqrt(Math.max(0, total2));
  const stability: Record<TermId, number> = {
    policy: clamp1(1 - 2.5 * t.clip.sigma - 0.3 * t.clip.clipped + 0.05 * hashNoise(t.step, 35)),
    value: clamp1(0.85 + 0.05 * hashNoise(t.step, 36)),
    entropy: clamp1(0.8 + 0.05 * hashNoise(t.step, 37)),
    kl: clamp1(0.93 + 0.03 * hashNoise(t.step, 38)),
  };
  const terms = {} as Record<TermId, TermGradient>;
  TERM_IDS.forEach((id, i) => {
    const dot = TERM_IDS.reduce((s, b, j) => s + norms[b] * (cos[i]?.[j] ?? 0), 0);
    const jittered = PROFILE[id].map((w, g) => w * (1 + 0.15 * hashNoise(t.step, 50 + 10 * i + g)));
    const sum = jittered.reduce((s, w) => s + w, 0);
    terms[id] = {
      norm: norms[id],
      align: total > 0 ? clamp1(dot / total) : 0,
      stability: stability[id],
      byGroup: jittered.map((w) => (sum > 0 ? w / sum : 0)),
    };
  });
  return { terms, cos, total };
}

export interface GradientRow {
  step: number;
  /** cos(g_k, g_total) per term. */
  align: Record<TermId, number>;
  /** ‖c_k g_k‖ per term. */
  norm: Record<TermId, number>;
}

/** The gradient view over a run, one row per step. */
export function gradientRows(history: readonly TrainStep[], p: TrainParams): GradientRow[] {
  return history.map((t) => {
    const v = gradientView(t, p);
    const align = {} as Record<TermId, number>;
    const norm = {} as Record<TermId, number>;
    for (const id of TERM_IDS) {
      align[id] = v.terms[id].align;
      norm[id] = v.terms[id].norm;
    }
    return { step: t.step, align, norm };
  });
}
