/**
 * graph.ts — the catalog page's cell graph: two cells over the wave, built so
 * the cell STATES can be watched. `samples` is synchronous and settles at
 * once; `summary` takes four deliberate steps with progress and fails on
 * demand, so pending, refreshing with the last value kept, and errored with
 * Retry can all be seen through the real `CellView`. Plus the standard agent
 * tools every aiui app registers. Rebuilt over the durable roots on every hot
 * edit (hotCellGraph).
 */
import {
  agentToolkit,
  type Cell,
  cell,
  hotCellGraph,
  registerStandardTools,
} from "@habemus-papadum/aiui-viz";
import { appScope, breakSummary, damping, frequency, shape } from "./store";
import { type Point, sampleWave, type WaveSummary, waveSummary } from "./wave";

/** A cancellable pause — the cell's abort signal ends it early. */
function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(signal.reason ?? new DOMException("aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

export interface CatalogCells {
  /** The specimen wave, sampled: 240 points over two seconds. */
  samples: Cell<Point[]>;
  /** Summary statistics of the wave — deliberately slow, so its states show. */
  summary: Cell<WaveSummary>;
}

/** The cells; the graph below and the headless test both build from here. */
export function buildCells(): CatalogCells {
  const samples = cell(
    () => ({ frequency: frequency.get(), damping: damping.get(), shape: shape.get() }),
    (p) => sampleWave(p),
    { scope: appScope },
  );
  const summary = cell(
    () => ({ points: samples(), fail: breakSummary.get() }),
    async ({ points, fail }, ctx): Promise<WaveSummary> => {
      for (let i = 1; i <= 4; i++) {
        await wait(180, ctx.signal);
        ctx.progress(i / 4);
      }
      if (fail) throw new Error("the summary failed on request — flip the switch back, then Retry");
      return waveSummary(points);
    },
    { scope: appScope },
  );
  return { samples, summary };
}

export const graph = hotCellGraph(appScope.name, buildCells, import.meta.hot);

export type AppGraph = ReturnType<typeof graph>;

// The agent surface, derived from the declarations: report, set, locate,
// read-page, selection, sources, source, and one tool per action (randomize).
const kit = agentToolkit(appScope.name, {
  brief:
    "The aiui-viz catalog, rendered as a page: every piece the package provides, with the " +
    "piece itself shown live where it can be. The only state is one damped wave — frequency, " +
    "damping and shape — which every live specimen on the page reads.",
});
registerStandardTools(kit);
