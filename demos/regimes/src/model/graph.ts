/**
 * graph.ts — the cell graph (playbook layer 2): every measured quantity on the
 * page, one cell per panel, plus the agent tool surface.
 *
 * The math is pure and synchronous (model/*.ts), so these cells are thin deps
 * bundles handed to the pure functions — the one place each panel's
 * dependencies are declared (guarded by the per-input probes in graph.test.ts).
 * Wrapping them as cells buys attribution, the agent `report`, and CellView
 * chrome; every Monte-Carlo input includes the durable seed, so `reseed`
 * re-rolls every panel at once.
 */
import {
  action,
  agentToolkit,
  cell,
  hotCellGraph,
  registerStandardTools,
} from "@habemus-papadum/aiui-viz";
import { divergence, invariantHistogram, trajectoryPair } from "./chaos";
import { dieDistribution, entropyBits, pointwiseFloor, simulateDie } from "./dice";
import { decompose, ensemble, makeDataset, signalVariance } from "./regress";
import { lossCurve, spectralState } from "./spectral";
import {
  appScope,
  degree,
  dieRolls,
  heterogeneous,
  loadedness,
  members,
  noise,
  perturbation,
  samples,
  seed,
  smoothness,
  trainTime,
} from "./store";

export const graph = hotCellGraph(
  appScope.name,
  () => {
    /** §1 — the loaded die: its distribution, both floors, and a scored run. */
    const die = cell(
      () => ({ L: loadedness.get(), n: dieRolls.get(), s: seed.get() }),
      ({ L, n, s }) => {
        const p = dieDistribution(L);
        return {
          p,
          entropy: entropyBits(p),
          pointwiseFloor: pointwiseFloor(p),
          run: simulateDie(p, n, s),
        };
      },
      { scope: appScope },
    );

    /** §2–§3 — the four-term decomposition of the regression simulator,
     * measured by refitting on 32 independent draws. */
    const decomp = cell(
      () => ({ degree: degree.get(), n: samples.get(), sigma: noise.get(), s: seed.get() }),
      ({ degree: d, n, sigma, s }) => decompose({ degree: d, n, sigma, trials: 32, seed: s }),
      { scope: appScope },
    );

    /** §2 — one visible dataset (the first Monte-Carlo draw) plus the signal
     * variance, for the scatter and the SNR readout. */
    const world = cell(
      () => ({ n: samples.get(), sigma: noise.get(), s: seed.get() }),
      ({ n, sigma, s }) => ({ data: makeDataset(n, sigma, s), signal: signalVariance(), sigma }),
      { scope: appScope },
    );

    /** §4 — the ensembling curve: test MSE of the M-average, M = 1…members,
     * plus the truth-free disagreement gauge. */
    const ens = cell(
      () => ({
        degree: degree.get(),
        n: samples.get(),
        sigma: noise.get(),
        M: members.get(),
        het: heterogeneous.get(),
        s: seed.get(),
      }),
      ({ degree: d, n, sigma, M, het, s }) =>
        ensemble({ degree: d, n, sigma, maxM: M, seed: s, heterogeneous: het }),
      { scope: appScope },
    );

    /** §5 — the exact gradient-flow state at the scrubbed training time. */
    const spectral = cell(
      () => ({ alpha: smoothness.get(), tLog: trainTime.get() }),
      ({ alpha, tLog }) => ({
        state: spectralState(alpha, 10 ** tLog),
        curve: lossCurve(alpha),
        t: 10 ** tLog,
      }),
      { scope: appScope },
    );

    /** §6 — chaos: mean divergence of ε-separated pairs, one visible fraying
     * pair, and the invariant histogram vs the arcsine law. */
    const chaos = cell(
      () => ({ epsLog: perturbation.get(), s: seed.get() }),
      ({ epsLog, s }) => {
        const eps = 10 ** epsLog;
        return {
          eps,
          div: divergence(eps, 60, 400, s),
          pair: trajectoryPair(0.31, eps, 60),
          inv: invariantHistogram(150_000, 48, s),
        };
      },
      { scope: appScope },
    );

    return { die, decomp, world, ens, spectral, chaos };
  },
  import.meta.hot,
);

/** The graph's shape, inferred — components type against it. */
export type AppGraph = ReturnType<typeof graph>;

// --- the agent surface --------------------------------------------------------

const kit = agentToolkit(appScope.name);
registerStandardTools(kit);

/** Re-roll every Monte-Carlo panel: bump the shared seed (die run, datasets,
 * refits, chaos starts all redraw; the closed-form panels are unaffected).
 * Shared by the page's reseed buttons and the agent action. */
export function reseed(): { seed: number } {
  const next = (seed.get() * 48271) % 2147483647 || 20260808;
  seed.set(next);
  return { seed: next };
}

action({
  scope: appScope,
  name: "reseed",
  run: () => reseed(),
});
