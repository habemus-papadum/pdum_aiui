/**
 * spectral.ts — spectral bias as an exactly-solved gradient flow (layer 1, pure).
 *
 * Target: f(x) = Σ_k a_k sin(kπx) with amplitudes a_k = k^(−α) (α is the
 * "smoothness" knob; α = 0 is white — every frequency equally loud). Fit it by
 * gradient flow on least squares under a smooth kernel whose eigenmodes are
 * those same sinusoids with eigenvalues λ_k = k^(−2). In that basis the flow
 * decouples exactly:
 *
 *     residual_k(t) = a_k · exp(−λ_k t)
 *
 * so mode k is learned on timescale 1/λ_k = k² — coarse structure first, fine
 * detail polynomially later. No simulation error: the closed form IS the
 * dynamics, which is the point (the section is about optimization, not noise).
 */

export const MODES = 24;

/** Target amplitude of mode k (1-based): k^(−α), α ∈ [0, 2]. */
export function amplitude(k: number, alpha: number): number {
  return k ** -alpha;
}

/** Kernel eigenvalue of mode k: λ_k = k^(−2) (a smooth-function prior). */
export function eigenvalue(k: number): number {
  return k ** -2;
}

export interface SpectralState {
  /** Mode numbers 1…MODES. */
  k: number[];
  /** Target amplitude per mode. */
  target: number[];
  /** Learned amplitude per mode at time t. */
  learned: number[];
  /** Fraction of each mode still unlearned: e^(−λ_k t). */
  residualFrac: number[];
  /** Σ residual²: the training loss at time t. */
  loss: number;
  /** Loss at t = 0 (for a fixed y-scale). */
  loss0: number;
  x: number[];
  /** Target curve on the grid. */
  fTarget: number[];
  /** The fit at time t on the grid. */
  fLearned: number[];
}

/** The exact state of the gradient flow at training time t. */
export function spectralState(alpha: number, t: number, gridN = 241): SpectralState {
  const k: number[] = [];
  const target: number[] = [];
  const learned: number[] = [];
  const residualFrac: number[] = [];
  let loss = 0;
  let loss0 = 0;
  for (let m = 1; m <= MODES; m++) {
    const a = amplitude(m, alpha);
    const frac = Math.exp(-eigenvalue(m) * t);
    k.push(m);
    target.push(a);
    learned.push(a * (1 - frac));
    residualFrac.push(frac);
    loss += (a * frac) ** 2;
    loss0 += a * a;
  }
  const x = Array.from({ length: gridN }, (_, i) => -1 + (2 * i) / (gridN - 1));
  const fTarget = x.map((xx) => {
    let s = 0;
    for (let m = 0; m < MODES; m++) s += target[m] * Math.sin((m + 1) * Math.PI * xx);
    return s;
  });
  const fLearned = x.map((xx) => {
    let s = 0;
    for (let m = 0; m < MODES; m++) s += learned[m] * Math.sin((m + 1) * Math.PI * xx);
    return s;
  });
  return { k, target, learned, residualFrac, loss, loss0, x, fTarget, fLearned };
}

/** Loss-vs-time curve on a log-time grid (for the training-curve panel). */
export function lossCurve(
  alpha: number,
  tMaxLog10 = 4,
  points = 121,
): { t: number[]; loss: number[] } {
  const t: number[] = [];
  const loss: number[] = [];
  for (let i = 0; i < points; i++) {
    const tt = 10 ** (-1 + ((tMaxLog10 + 1) * i) / (points - 1));
    let l = 0;
    for (let m = 1; m <= MODES; m++) {
      const r = amplitude(m, alpha) * Math.exp(-eigenvalue(m) * tt);
      l += r * r;
    }
    t.push(tt);
    loss.push(l);
  }
  return { t, loss };
}
