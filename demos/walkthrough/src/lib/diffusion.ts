/**
 * diffusion.ts — the pure math of 1-D heat diffusion (playbook layer 1).
 *
 * Everything here is realm-free: values in, values out — no framework, no
 * time, no DOM, no worker globals. That is what lets the same functions run
 * on the page (step 1's static profiles), inside the worker (the evolution),
 * and under Vitest (diffusion.test.ts, exhaustively; diffusion.bench.ts for
 * the numbers that decided the worker question).
 *
 * The model: a rod on x ∈ [0, 1] with fixed cold ends (Dirichlet u = 0),
 * marched by the explicit FTCS scheme
 *
 *     u'ᵢ = uᵢ + r · (uᵢ₋₁ − 2uᵢ + uᵢ₊₁),   r = κ·Δt/Δx²
 *
 * which is stable only for r ≤ ½ — `stableDt` is that limit, and the worker
 * always steps at a safe fraction of it. For the gaussian initial condition
 * the free-space solution is closed-form (`analyticGaussian`), giving the
 * error norms an honest reference while the pulse stays away from the walls.
 */

export type InitialCondition = "gaussian" | "step" | "two-pulses" | "noise";

/** Every initial condition, in display order (the `ic` control's options). */
export const INITIAL_CONDITIONS: readonly InitialCondition[] = [
  "gaussian",
  "step",
  "two-pulses",
  "noise",
];

/** Gaussian pulse parameters shared by the IC and its analytic reference. */
export const GAUSSIAN = { x0: 0.5, sigma0: 0.05 };

/** Deterministic PRNG (mulberry32) — the seeded "noise" IC must replay. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** An initial temperature profile on n grid points, u ∈ [0, 1], ends at 0. */
export function initialProfile(kind: InitialCondition, n: number, seed = 1): Float64Array {
  const u = new Float64Array(n);
  const x = (i: number) => i / (n - 1);
  switch (kind) {
    case "gaussian": {
      const { x0, sigma0 } = GAUSSIAN;
      for (let i = 1; i < n - 1; i++) {
        u[i] = Math.exp(-((x(i) - x0) ** 2) / (2 * sigma0 * sigma0));
      }
      break;
    }
    case "step": {
      for (let i = 1; i < n - 1; i++) {
        u[i] = x(i) >= 0.4 && x(i) <= 0.6 ? 1 : 0;
      }
      break;
    }
    case "two-pulses": {
      for (let i = 1; i < n - 1; i++) {
        const a = Math.exp(-((x(i) - 0.3) ** 2) / (2 * 0.03 ** 2));
        const b = 0.6 * Math.exp(-((x(i) - 0.7) ** 2) / (2 * 0.05 ** 2));
        u[i] = a + b;
      }
      break;
    }
    case "noise": {
      const rand = mulberry32(seed);
      for (let i = 1; i < n - 1; i++) {
        u[i] = rand();
      }
      break;
    }
  }
  return u; // u[0] and u[n-1] stay 0: the Dirichlet walls
}

/**
 * One explicit FTCS step with fixed ends. Writes into `out` (allocate once,
 * ping-pong two buffers — the shape the benchmark measures).
 */
export function diffusionStep(u: Float64Array, r: number, out: Float64Array): Float64Array {
  const n = u.length;
  out[0] = 0;
  out[n - 1] = 0;
  for (let i = 1; i < n - 1; i++) {
    out[i] = u[i] + r * (u[i - 1] - 2 * u[i] + u[i + 1]);
  }
  return out;
}

/** The largest stable time step for the explicit scheme: Δx²/(2κ). */
export function stableDt(kappa: number, dx: number): number {
  return (dx * dx) / (2 * kappa);
}

/**
 * The free-space solution for the gaussian IC at time t: the pulse stays
 * gaussian with σ(t) = √(σ₀² + 2κt) and amplitude σ₀/σ(t). Valid as a
 * reference while the pulse is far from the walls (the numerical run has
 * cold ends; the analytic one does not).
 */
export function analyticGaussian(n: number, t: number, kappa: number): Float64Array {
  const { x0, sigma0 } = GAUSSIAN;
  const sigma = Math.sqrt(sigma0 * sigma0 + 2 * kappa * t);
  const amp = sigma0 / sigma;
  const u = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const x = i / (n - 1);
    u[i] = amp * Math.exp(-((x - x0) ** 2) / (2 * sigma * sigma));
  }
  return u;
}

/** Discrete L2 error between two profiles, √(mean((a−b)²)). */
export function l2Error(a: Float64Array, b: Float64Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return Math.sqrt(sum / a.length);
}

/** Max-norm error between two profiles. */
export function maxError(a: Float64Array, b: Float64Array): number {
  let m = 0;
  for (let i = 0; i < a.length; i++) {
    m = Math.max(m, Math.abs(a[i] - b[i]));
  }
  return m;
}
