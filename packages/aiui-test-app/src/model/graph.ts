/**
 * graph.ts — the cell graph: every dataflow in the app, in one place.
 *
 * Five cells, chained:
 *
 *     samples ──┬─→ histogram ──┐
 *               │               ├─→ curves
 *               ├─→ moments ──┐ │
 *               │             │ │
 *               └─────────────┴─┴─→ fit ─→ (curves)
 *
 *   samples    draw N points from the mixture   (async, abortable, progress)
 *   histogram  bin them                          (sync, cheap)
 *   moments    mean / sd / skewness              (sync, cheap)
 *   fit        EM, one yield per iteration       (async iterable — streams)
 *   curves     the plottable geometry            (recomputes as `fit` streams)
 *
 * Note what is NOT written here: no `cell(deps, compute, { name, loc })`. The
 * source-locator babel pass (the `aiui()` plugin in
 * vite.config.ts) injects each cell's `{ name, loc }` from its declaration at
 * compile time, so `const samples = cell(…)` registers as "samples" and
 * `CellView` stamps `data-cell="samples"` on the element that renders it.
 * Passing them by hand is redundant, and it drifts the moment the code moves.
 *
 * This module is *disposable logic*: it builds the graph from the durable
 * roots in store.ts, publishes it through a durable box, and on a hot edit
 * disposes the old graph and swaps in a new one. Sliders keep their positions;
 * every cell recomputes. The UI reads the box, never a module export, so it can
 * never hold a stale cell.
 */
import {
  agentToolkit,
  type Cell,
  cell,
  cellGraph,
  cellRegistry,
  durable,
} from "@habemus-papadum/aiui-viz";
import { createSignal } from "solid-js";
import {
  buildHistogram,
  computeMoments,
  densityCurve,
  drawSample,
  emStep,
  type FitStep,
  type Histogram,
  initialGuess,
  type MixtureParams,
  type Moments,
  mulberry32,
} from "./mixture";
import {
  bins,
  clampParam,
  LIMITS,
  mu1,
  mu2,
  PARAMS,
  type ParamName,
  readParams,
  sampleCount,
  seed,
  sigma1,
  sigma2,
  weight,
} from "./store";

/** How many EM iterations to run, and how long to pause between yields. */
export const EM_ITERATIONS = 24;
const EM_FRAME_MS = 50;
/** Points drawn per chunk before yielding to the event loop (keeps aborts live). */
const SAMPLE_CHUNK = 2000;

/** The plottable geometry: bars plus two density curves over one shared range. */
export interface Curves {
  lo: number;
  hi: number;
  /** Y extent, padded — bars and both curves fit under it. */
  yMax: number;
  bars: Array<{ x: number; y: number; width: number }>;
  truth: Array<{ x: number; y: number }>;
  fitted: Array<{ x: number; y: number }>;
}

export interface AppGraph {
  samples: Cell<Float64Array>;
  histogram: Cell<Histogram>;
  moments: Cell<Moments>;
  fit: Cell<FitStep>;
  curves: Cell<Curves>;
}

/** The model the samples are actually drawn from — read reactively. */
function trueParams(): MixtureParams {
  return {
    weight: weight.get(),
    mu1: mu1.get(),
    sigma1: sigma1.get(),
    mu2: mu2.get(),
    sigma2: sigma2.get(),
  };
}

// --- the durable box the UI subscribes to ------------------------------------

const graphBox = durable("graphBox", () => {
  const [get, set] = createSignal<{ graph: AppGraph; dispose: () => void }>();
  return { get, set };
});

/** The current graph — a stable accessor that survives hot swaps. */
export const appGraph = (): AppGraph | undefined => graphBox.get()?.graph;

// --- graph construction ------------------------------------------------------

function build(): { graph: AppGraph; dispose: () => void } {
  return cellGraph(() => {
    // The `Cell<…>` annotations on `samples` and `fit` are load-bearing, not
    // decoration: a compute may return `T | Promise<T> | AsyncIterable<T>`, and
    // from an async body TS cannot tell which arm of that union it is looking
    // at — it gives up and infers `unknown`. The annotation supplies `T`
    // contextually. The sync cells infer fine on their own.

    // 1. The data. Chunked so a slider drag can abort a run in flight: each
    //    chunk boundary is a macrotask, which is the only place `signal.aborted`
    //    can have become true.
    const samples: Cell<Float64Array> = cell(
      () => ({ n: sampleCount.get(), s: seed.get(), params: trueParams() }),
      async ({ n, s, params }, ctx) => {
        const rand = mulberry32(s);
        const out = new Float64Array(n);
        for (let i = 0; i < n; i++) {
          out[i] = drawSample(params, rand);
          if ((i + 1) % SAMPLE_CHUNK === 0) {
            await new Promise((r) => setTimeout(r, 0));
            if (ctx.signal.aborted) return out; // superseded — the value is discarded
            ctx.progress((i + 1) / n);
          }
        }
        ctx.progress(1);
        return out;
      },
    );

    // 2 & 3. Two independent readings of the same data. Reading `samples()` in
    //        a deps function throws NotReadyError while it is pending, which is
    //        exactly how a downstream cell holds without any explicit guard.
    const histogram = cell(
      () => ({ data: samples(), count: bins.get() }),
      ({ data, count }) => buildHistogram(data, count),
    );

    const moments = cell(
      () => samples(),
      (data) => computeMoments(data),
    );

    // 4. EM, streaming. `stream: "commit"` is the default, so every yield is
    //    committed to the graph and `curves` below recomputes per iteration —
    //    the fitted curve visibly walks onto the data.
    const fit: Cell<FitStep> = cell(
      () => ({ data: samples(), start: initialGuess(moments()) }),
      async function* ({ data, start }, ctx) {
        let params = start;
        for (let iter = 1; iter <= EM_ITERATIONS; iter++) {
          if (ctx.signal.aborted) return;
          const step = emStep(data, params);
          params = step.params;
          ctx.progress(iter / EM_ITERATIONS);
          yield { iter, params, logLik: step.logLik };
          await new Promise((r) => setTimeout(r, EM_FRAME_MS));
        }
      },
    );

    // 5. Geometry for the chart: the bars, the true density, and the current
    //    EM estimate, all on one shared range and y-scale.
    const curves = cell(
      () => ({ hist: histogram(), step: fit(), truth: trueParams() }),
      ({ hist, step, truth }): Curves => {
        const truthCurve = densityCurve(hist.lo, hist.hi, truth);
        const fittedCurve = densityCurve(hist.lo, hist.hi, step.params);
        const peak = Math.max(
          ...hist.density,
          ...truthCurve.map((p) => p.y),
          ...fittedCurve.map((p) => p.y),
        );
        return {
          lo: hist.lo,
          hi: hist.hi,
          yMax: peak * 1.1,
          bars: hist.centers.map((x, i) => ({
            x,
            y: hist.density[i],
            width: hist.width,
          })),
          truth: truthCurve,
          fitted: fittedCurve,
        };
      },
    );

    return { samples, histogram, moments, fit, curves } satisfies AppGraph;
  });
}

// --- agent tools -------------------------------------------------------------
//
// Every operation a human can perform has a tool twin, so the agent can drive
// and inspect the app rather than guess at it.

function registerTools(): void {
  const { registerTool, registerReporter } = agentToolkit("testapp");

  registerTool({
    name: "get-params",
    description: "Every tunable of the mixture model and the sampler.",
    run: () => readParams(),
  });

  registerTool({
    name: "set-params",
    description:
      "Set one or more tunables. Values are clamped to their slider bounds; the graph recomputes.",
    params: Object.fromEntries(
      Object.entries(LIMITS).map(([name, { min, max }]) => [name, `number in ${min}..${max}`]),
    ),
    run: (args) => {
      // Return what was written, not a fresh read: Solid 2.0 commits signal
      // writes transactionally, so a same-scope .get() still sees old values.
      const next = readParams();
      for (const [key, box] of Object.entries(PARAMS) as Array<
        [ParamName, (typeof PARAMS)[ParamName]]
      >) {
        const raw = args?.[key];
        if (typeof raw === "number" && Number.isFinite(raw)) {
          next[key] = clampParam(key, raw);
          box.set(next[key]);
        }
      }
      return next;
    },
  });

  registerTool({
    name: "reseed",
    description: "Redraw the sample from the same model with a fresh PRNG seed.",
    run: () => {
      const next = (seed.get() + 1) >>> 0;
      seed.set(next);
      return { seed: next };
    },
  });

  // The attribution table: every live named cell, its state, and where it is
  // defined — the names match the data-cell stamps in the DOM.
  registerReporter("cells", () => cellRegistry());
  registerReporter("params", () => readParams());
}

// --- module evaluation = (re)build -------------------------------------------

graphBox.get()?.dispose(); // an HMR re-evaluation swaps the previous graph out
graphBox.set(build());
registerTools(); // idempotent by name — re-registration replaces
if (import.meta.hot) {
  import.meta.hot.accept(() => {
    console.info("[test-app:hmr] graph rebuilt over durable roots");
  });
}
