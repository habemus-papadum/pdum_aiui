/** The lab's cell graph, the trainer bridge, and the agent surface. */

import {
  action,
  agentToolkit,
  bridgeEffect,
  cell,
  hotCellGraph,
  registerStandardTools,
} from "@habemus-papadum/aiui-viz";
import { measureFidelity } from "./fidelity";
import { type FourierSample, sampleSeries } from "./fourier";
import { type GradientRow, type GradientView, gradientRows, gradientView } from "./gradients";
import { type StageState, schedule, stagesOf } from "./pipeline";
import { evaluateStep, STEPS, type StepEvaluation } from "./quadratic";
import {
  clock,
  epochs,
  harmonics,
  labScope,
  lens,
  muted,
  params,
  playing,
  qa,
  qb,
  qc,
  runner,
  running,
  select,
  selected,
  speed,
  step,
  toggleMuted,
  train,
  trainer,
  withEval,
} from "./store";
import {
  type ClipMeans,
  type ClipRow,
  clipSummary,
  type TermId,
  type TermMagnitude,
  type TrainStep,
  termMagnitudes,
} from "./training";

export interface TrainRow {
  step: number;
  loss: number;
  policy: number;
  value: number;
  entropy: number;
  kl: number;
}

export const graph = hotCellGraph(
  labScope.name,
  () => {
    // The trainer is an imperative island (an interval in a durable box);
    // the controls reach it through one hardened crossing.
    bridgeEffect(
      () => ({ on: playing.get(), hz: speed.get() }),
      (v) => {
        if (v.on) trainer.start(v.hz);
        else trainer.stop();
      },
      { scope: labScope, name: "trainer" },
    );
    // The pipeline's clock driver, the same way.
    bridgeEffect(
      () => running.get(),
      (on) => {
        if (on) runner.start();
        else runner.stop();
      },
      { scope: labScope, name: "runner" },
    );

    return {
      /** The newest step: each term's magnitude and share of the loss, and
       * the synthetic gradient view of the same step. */
      latest: cell(
        () => ({ h: train.get(), p: params() }),
        (deps): { step: TrainStep; terms: Record<TermId, TermMagnitude>; grad: GradientView } => {
          const last = deps.h[deps.h.length - 1] as TrainStep;
          return {
            step: last,
            terms: termMagnitudes(last, deps.p),
            grad: gradientView(last, deps.p),
          };
        },
        { scope: labScope },
      ),

      // The three series below each serve one lens and are GATED on it: a
      // ticking history re-derives 600 rows per tick, and only the lens on
      // screen should pay (Solid's HOT_SCOPE_TIME flagged the gradient rows
      // at 8 ms per second with all three live).

      /** The clip fractions over the run, and their means — the clipping lens. */
      clipSeries: cell(
        () => (lens.get() === "clipping" ? { h: train.get() } : undefined),
        (deps): { rows: ClipRow[]; mean: ClipMeans } => clipSummary(deps.h),
        { scope: labScope },
      ),

      /** Each term's alignment and norm over the run — the gradient lens. */
      gradSeries: cell(
        () => (lens.get() === "gradient" ? { h: train.get(), p: params() } : undefined),
        (deps): GradientRow[] => gradientRows(deps.h, deps.p),
        { scope: labScope },
      ),

      /** The run as rows for the plot: the loss and the four magnitudes — the magnitude lens. */
      lossSeries: cell(
        () => (lens.get() === "magnitude" ? { h: train.get(), p: params() } : undefined),
        (deps): TrainRow[] =>
          deps.h.map((s) => {
            const m = termMagnitudes(s, deps.p);
            return {
              step: s.step,
              loss: s.loss,
              policy: m.policy.value,
              value: m.value.value,
              entropy: m.entropy.value,
              kl: m.kl.value,
            };
          }),
        { scope: labScope },
      ),

      /** The current derivation step evaluated at the + root of (a, b, c). */
      derivation: cell(
        () => ({ i: step.get(), p: { a: qa.get(), b: qb.get(), c: qc.get() } }),
        (deps): StepEvaluation => evaluateStep(STEPS[deps.i] as (typeof STEPS)[number], deps.p),
        { scope: labScope },
      ),

      /** The square wave's partial sum and harmonics, sampled. */
      fourier: cell(
        () => ({ n: harmonics.get(), muted: muted.get() }),
        (deps): FourierSample[] => sampleSeries(deps.n, new Set(deps.muted)),
        { scope: labScope },
      ),

      /** Where the pipeline run stands: every stage's status, progress, rows. */
      pipeline: cell(
        () => ({ p: { epochs: epochs.get(), withEval: withEval.get() }, t: clock.get() }),
        (deps): Record<string, StageState> => schedule(deps.p, deps.t),
        { scope: labScope },
      ),
    };
  },
  import.meta.hot,
);

export type LabGraph = ReturnType<typeof graph>;

// ── the agent surface ────────────────────────────────────────────────────────

const kit = agentToolkit(labScope.name, {
  brief:
    "The aiui-viz lab. RichTeX pages: four pages exercising an equation built from addressable pieces. " +
    "`training` runs a fake PPO objective whose symbols ε, β, c_v, c_H are knobs (drag them in " +
    "the equation, or `set` them); `lens` picks the annotation family on it — magnitude (each " +
    "term's share), clipping (which argument the min takes, which bound clips, from a simulated " +
    "batch per step), gradient (each term's pull and alignment, synthetic). `derivation` steps " +
    "through completing the square with every term evaluated; `fourier` sums a square wave's " +
    "harmonics; `fidelity` proves the markers change no layout (measure-fidelity reads it). " +
    "Mermaid pages: `pipeline` is a build pipeline drawn as a flowchart whose stages are " +
    "clickable (select-stage), run by `clock`/`running`, with the `train` node a drag-knob for " +
    "`epochs`; `anatomy` renders any Mermaid source and lists what became addressable.",
});
registerStandardTools(kit);

/** Restart the training run at step 0 (the same deterministic run replays). */
export const resetTraining = action({
  scope: labScope,
  run: () => {
    trainer.reset();
    return "training restarted at step 0";
  },
});

/**
 * Mute or unmute one harmonic of the Fourier page by its k (1, 3, 5, …).
 * @usage Call to take a term out of the partial sum; the equation strikes it
 * through and the plot drops its wave. Returns the new muted state.
 * @example toggle-harmonic { "k": 3 }
 */
export const toggleHarmonic = action({
  scope: labScope,
  params: { k: "the harmonic's k — an odd integer" },
  run: (args) => {
    const k = Number(args?.k);
    if (!Number.isInteger(k) || k < 1 || k % 2 === 0) return "k must be an odd positive integer";
    return `harmonic ${k} ${toggleMuted(k) ? "muted" : "unmuted"}`;
  },
});

/**
 * Select a stage of the pipeline page by id (the node's id in the diagram),
 * as a click on the node would; the same id again clears the selection.
 * @usage The stage's details panel opens and its edges light up.
 * @example select-stage { "id": "train" }
 */
export const selectStage = action({
  scope: labScope,
  params: { id: "a stage id: raw, clean, feat, train, eval, ship, deploy" },
  run: (args) => {
    const id = String(args?.id ?? "");
    const p = { epochs: epochs.get(), withEval: withEval.get() };
    if (!stagesOf(p).some((s) => s.id === id)) return `no stage "${id}" in the current diagram`;
    select(id);
    return selected.get() === id ? `selected ${id}` : `cleared the selection`;
  },
});

/** Rewind the pipeline run to t = 0 and stop the clock. */
export const resetRun = action({
  scope: labScope,
  run: () => {
    running.set(false);
    clock.set(0);
    return "run rewound to 0 s";
  },
});

/**
 * Measure the fidelity page: every glyph of each plain render paired with the
 * marked render's, the largest positional difference in px per case.
 * @usage Read-only; navigate to /fidelity first. `ok` is false if any glyph
 * moved by 0.5px or more, or the glyph counts differ.
 */
export const measureFidelityCases = action({
  scope: labScope,
  kind: "read",
  run: () => measureFidelity(document),
});

if (import.meta.hot) import.meta.hot.accept();
