/**
 * graph.ts — the cell graph (playbook layer 2): the evolution and everything
 * derived from it, plus the app's one action. Cells wrap the pure functions of
 * layer 1 with reality — the worker, cancellation-by-supersession (drag κ
 * mid-run and the worker really stops), streaming partials, progress.
 *
 * `buildGraph` takes the worker as a parameter so the headless tests
 * (graph.test.ts) can hand it a stub speaking the same protocol — the graph's
 * dataflow is then testable with zero real workers (jsdom has none).
 */
import {
  action,
  agentToolkit,
  type Cell,
  cell,
  fromWorker,
  hotCellGraph,
  registerStandardTools,
} from "@habemus-papadum/aiui-viz";
import { analyticGaussian, l2Error, maxError } from "../lib/diffusion";
import type { Evolution, EvolutionParams } from "./diffusion.worker";
import { diffusionWorker, FRAME_COUNT, ic, kappa, points, seed, simTime } from "./store";

export interface WalkthroughGraph {
  /** The full run: frames streaming in from the worker. */
  evolution: Cell<Evolution>;
  /** The latest computed profile (the last frame so far). */
  profile: Cell<{ t: number; u: Float64Array }>;
  /** Numerical-vs-analytic error norms — gaussian IC only (gated otherwise). */
  errors: Cell<{ l2: number; max: number; t: number }>;
}

export function buildGraph(worker: () => Worker = diffusionWorker): WalkthroughGraph {
  /** The evolution, streamed from the worker; any input change supersedes. */
  const evolution = cell(
    () => ({
      kappa: kappa.get(),
      n: points.get(),
      ic: ic.get(),
      seed: seed.get(),
      simTime: simTime.get(),
      frames: FRAME_COUNT,
    }),
    fromWorker<EvolutionParams, Evolution>(worker),
  );

  /** The newest profile — recomputes per streamed partial (commit mode). */
  const profile = cell(
    () => ({ e: evolution() }),
    (d) => {
      const last = d.e.frames[d.e.frames.length - 1];
      return { t: last.t, u: last.u };
    },
  );

  /** Error norms against the free-space gaussian; held for other ICs. */
  const errors = cell(
    () => {
      if (ic.get() !== "gaussian") return undefined; // no reference - hold
      return { p: profile(), kappa: kappa.get(), n: points.get() };
    },
    (d) => {
      const reference = analyticGaussian(d.n, d.p.t, d.kappa);
      return { l2: l2Error(d.p.u, reference), max: maxError(d.p.u, reference), t: d.p.t };
    },
  );

  return { evolution, profile, errors };
}

/** The current graph - a stable accessor that survives hot swaps. */
export const graph = hotCellGraph<WalkthroughGraph>("walkthrough", buildGraph, import.meta.hot);

// --- the agent surface: derived from the declarations --------------------------

const kit = agentToolkit("walkthrough");
registerStandardTools(kit);

/** Re-roll the noise seed; the evolution re-runs from the new profile. */
action({
  name: "re-seed",
  run: () => {
    let next = 0;
    seed.set((s) => {
      next = (s + 1) >>> 0;
      return next;
    });
    return { seed: next };
  },
});
