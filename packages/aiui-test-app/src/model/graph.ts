/**
 * graph.ts — the cell graph: every dataflow in the app, in one place.
 *
 * Three cells, chained off the drawn components:
 *
 *     ellipses (durable) ──→ samples ──┬─→ hexes
 *                                      └─→ fit (worker, streams)
 *
 *   samples  draw N points from the drawn mixture  (async, abortable, progress)
 *   hexes    hex-bin them onto the board            (sync, cheap)
 *   fit      EM in the worker, one partial per      (async iterable — streams;
 *            iteration, JS or WebGPU backend         restarts on any new stroke)
 *
 * Supersession IS cancellation: drawing another ellipse changes `ellipses`,
 * `samples` re-runs (aborting any run in flight), and `fit`'s workerStream
 * posts `cancel` to the worker — the running EM actually stops.
 *
 * No cell writes its own `name`/`loc`: the source-locator babel pass (the
 * `aiui()` plugin in vite.config.ts) injects both from the declaration.
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
import type { EmProgress, EmRunParams } from "./em.worker";
import {
  clampEllipse,
  hexbin,
  mixtureFromEllipses,
  mulberry32,
  prepareSampler,
  samplePoint,
} from "./mixture2d";
import {
  appScope,
  BOARD_H,
  BOARD_W,
  backend,
  ellipses,
  emWorker,
  paper,
  sampleCount,
  seed,
} from "./store";

/** How many EM iterations a run streams, and the pause between partials. */
export const EM_ITERATIONS = 40;
const EM_FRAME_MS = 40;
/** Points drawn per chunk before yielding to the event loop (keeps aborts live). */
const SAMPLE_CHUNK = 4000;
/** Hex circumradius, board units — the "bin width" of the 2-D histogram. */
export const HEX_RADIUS = 11;

/** Build the graph — exported so headless tests build it inside `cellHarness`. */
export function buildGraph(worker: () => Worker = emWorker) {
  // 1. The data. Chunked so a slider drag or a fresh stroke aborts a draw in
  //    flight. Zero components legitimately yields zero points — the board
  //    empties rather than holding a stale cloud.
  const samples: Cell<Float64Array> = cell(
    () => ({ n: sampleCount.get(), s: seed.get(), list: ellipses.get() }),
    async ({ n, s, list }, ctx) => {
      if (list.length === 0) {
        return new Float64Array(0);
      }
      const mix = mixtureFromEllipses(list);
      const sampler = prepareSampler(mix);
      const rand = mulberry32(s);
      const out = new Float64Array(2 * n);
      for (let i = 0; i < n; i++) {
        const p = samplePoint(mix, sampler, rand);
        out[2 * i] = p.x;
        out[2 * i + 1] = p.y;
        if ((i + 1) % SAMPLE_CHUNK === 0) {
          await new Promise((r) => setTimeout(r, 0));
          if (ctx.signal.aborted) {
            return out; // superseded — the value is discarded
          }
          ctx.progress((i + 1) / n);
        }
      }
      ctx.progress(1);
      return out;
    },
    { scope: appScope },
  );

  // 2. The 2-D histogram: pointy-top hexes over the board.
  const hexes = cell(
    () => samples(),
    (data) => hexbin(data, HEX_RADIUS, BOARD_W, BOARD_H),
    { scope: appScope },
  );

  // 3. EM, streaming from the worker — one partial per iteration, each
  //    carrying the whole logLik trace so far and the backend that actually
  //    computed it. Holds (shows nothing new) while there are no components.
  const fit: Cell<EmProgress> = cell(
    () => {
      const k = ellipses.get().length;
      const data = samples();
      if (k === 0 || data.length === 0) {
        return undefined;
      }
      return {
        data,
        k,
        seed: seed.get(),
        iterations: EM_ITERATIONS,
        frameMs: EM_FRAME_MS,
        backend: backend.get(),
      } satisfies EmRunParams;
    },
    fromWorker<EmRunParams, EmProgress>(worker),
    { scope: appScope },
  );

  return { samples, hexes, fit };
}

/** The current graph — a stable accessor that survives hot swaps. */
export const graph = hotCellGraph("testapp", buildGraph, import.meta.hot);

/** The graph's shape, inferred — components type against it. */
export type AppGraph = ReturnType<typeof graph>;

// ── the agent surface ────────────────────────────────────────────────────────
//
// Declaring IS exposing: the standard tools derive `report`/`set`/`locate`
// and one named tool per action below from the declarations themselves.

const kit = agentToolkit("testapp");

/** Redraw the sample from the same components with a fresh PRNG seed. */
export const reseedAction = action({
  scope: appScope,
  name: "reseed",
  description: "Redraw the sample from the same mixture with a fresh PRNG seed.",
  run: () => {
    const next = (seed.get() + 1) >>> 0;
    seed.set(next);
    return { seed: next };
  },
});

/** Remove every drawn component (and any ink) — the reset. */
export const clearAction = action({
  scope: appScope,
  name: "clear",
  description: "Remove every drawn component and reset the board to empty.",
  run: () => {
    ellipses.set([]);
    paper.clearAnimated();
    return { components: 0 };
  },
});

/** Remove the most recently drawn component. */
export const undoAction = action({
  scope: appScope,
  name: "undo",
  description: "Remove the most recently drawn component.",
  run: () => {
    const remaining = Math.max(0, ellipses.get().length - 1);
    ellipses.set((list) => list.slice(0, -1));
    return { components: remaining };
  },
});

/** Add a component programmatically — the tool twin of drawing an ellipse. */
export const addEllipseAction = action({
  scope: appScope,
  name: "add-ellipse",
  description:
    "Add a mixture component as an ellipse (its 2σ contour), without drawing. Board is 680×460.",
  params: {
    cx: "number, centre x in 0..680",
    cy: "number, centre y in 0..460",
    a: "number, semi-major axis (board units, e.g. 40..150)",
    b: "number, semi-minor axis",
    angle: "number, tilt in radians (optional, default 0)",
  },
  run: (args) => {
    const num = (v: unknown, fallback: number): number =>
      typeof v === "number" && Number.isFinite(v) ? v : fallback;
    const e = clampEllipse(
      {
        cx: num(args?.cx, BOARD_W / 2),
        cy: num(args?.cy, BOARD_H / 2),
        a: num(args?.a, 80),
        b: num(args?.b, 50),
        angle: num(args?.angle, 0),
      },
      BOARD_W,
      BOARD_H,
    );
    ellipses.set((list) => [...list, e]);
    return e;
  },
});

registerStandardTools(kit);
