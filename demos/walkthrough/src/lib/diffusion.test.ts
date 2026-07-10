/**
 * diffusion.test.ts — playbook layer 1: the pure math, tested exhaustively and
 * cheaply. No framework, no owner, no ticks — the cheapest place in the app
 * to be thorough, so this is where the physics is pinned down.
 */
import { describe, expect, it } from "vitest";
import {
  analyticGaussian,
  diffusionStep,
  INITIAL_CONDITIONS,
  initialProfile,
  l2Error,
  maxError,
  stableDt,
} from "./diffusion";

/** March `steps` of FTCS at ratio r, ping-ponging two buffers. */
function march(u0: Float64Array, r: number, steps: number): Float64Array {
  let a = u0.slice();
  let b = new Float64Array(u0.length);
  for (let s = 0; s < steps; s++) {
    diffusionStep(a, r, b);
    [a, b] = [b, a];
  }
  return a;
}

describe("initial profiles", () => {
  it("every kind keeps the Dirichlet walls at zero and values in [0, ~1.1]", () => {
    for (const kind of INITIAL_CONDITIONS) {
      const u = initialProfile(kind, 129);
      expect(u[0]).toBe(0);
      expect(u[128]).toBe(0);
      expect(Math.min(...u)).toBeGreaterThanOrEqual(0);
      expect(Math.max(...u)).toBeLessThanOrEqual(1.1); // two-pulses may sum slightly over 1
    }
  });

  it("the seeded noise replays exactly, and a new seed differs", () => {
    expect(initialProfile("noise", 65, 7)).toEqual(initialProfile("noise", 65, 7));
    expect(initialProfile("noise", 65, 7)).not.toEqual(initialProfile("noise", 65, 8));
  });
});

describe("the FTCS step", () => {
  it("smooths: the max never grows, the min never drops (r ≤ ½)", () => {
    const u = initialProfile("step", 101);
    const after = march(u, 0.4, 50);
    expect(Math.max(...after)).toBeLessThanOrEqual(Math.max(...u));
    expect(Math.min(...after)).toBeGreaterThanOrEqual(0);
  });

  it("preserves the symmetry of a centred pulse", () => {
    const u = march(initialProfile("gaussian", 101), 0.45, 200);
    for (let i = 0; i < 50; i++) {
      expect(u[i]).toBeCloseTo(u[100 - i], 12);
    }
  });

  it("is unstable past the r = ½ limit — the reason stableDt exists", () => {
    const stable = march(initialProfile("step", 101), 0.5, 400);
    const unstable = march(initialProfile("step", 101), 0.55, 400);
    expect(Math.max(...stable.map(Math.abs))).toBeLessThanOrEqual(1);
    expect(Math.max(...unstable.map(Math.abs))).toBeGreaterThan(10); // blown up
  });

  it("stableDt is the r = ½ ratio", () => {
    const dx = 1 / 100;
    const kappa = 0.3;
    const dt = stableDt(kappa, dx);
    expect((kappa * dt) / (dx * dx)).toBeCloseTo(0.5, 12);
  });
});

describe("against the analytic gaussian", () => {
  it("the numerical march tracks the free-space solution while off the walls", () => {
    const n = 201;
    const kappa = 0.1;
    const dx = 1 / (n - 1);
    const dt = 0.9 * stableDt(kappa, dx);
    const steps = 400;
    const t = steps * dt;

    const numeric = march(initialProfile("gaussian", n), (kappa * dt) / (dx * dx), steps);
    const reference = analyticGaussian(n, t, kappa);

    expect(l2Error(numeric, reference)).toBeLessThan(1e-3);
    expect(maxError(numeric, reference)).toBeLessThan(5e-3);
  });

  it("refining the grid shrinks the error (convergence, the quantitative check)", () => {
    const run = (n: number) => {
      const kappa = 0.1;
      const dx = 1 / (n - 1);
      const dt = 0.9 * stableDt(kappa, dx);
      // March all grids to the SAME physical time.
      const t = 0.002;
      const steps = Math.round(t / dt);
      const u = march(initialProfile("gaussian", n), (kappa * dt) / (dx * dx), steps);
      return l2Error(u, analyticGaussian(n, steps * dt, kappa));
    };
    expect(run(201)).toBeLessThan(run(51));
  });
});
