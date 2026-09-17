/**
 * graph.ts — the cell graph. The slice's `params` cell is reused; the trace
 * is THIS app's cell because it depends on the `samples` control the slice
 * knows nothing about: `oscillatorTrace(params, TRACE_SECONDS, samples())`.
 * A sample count below ~2 × frequency × 4 s (the Nyquist floor for the
 * window) draws the cosine as a broken line — that is the jaggedness.
 */

import { oscillatorCells, oscillatorTrace, TRACE_SECONDS } from "@habemus-papadum/aiui-oscillator";
import { agentToolkit, cell, hotCellGraph, registerStandardTools } from "@habemus-papadum/aiui-viz";
import { appScope, osc, samples } from "./store";

export const graph = hotCellGraph(
  appScope.name,
  () => {
    const slice = oscillatorCells(appScope, osc);

    /** The trace at the chosen render density (points over the 4 s window). */
    const trace = cell(
      () => ({ p: slice.params(), n: samples.get() }),
      ({ p, n }) => oscillatorTrace(p, TRACE_SECONDS, n),
      { scope: appScope, name: "densityTrace" },
    );

    /** Points per cycle at the current frequency and density — below 2 the
     * trace cannot show the oscillation; below ~10 it looks jagged. */
    const pointsPerCycle = cell(
      () => ({ p: slice.params(), n: samples.get() }),
      ({ p, n }) => n / (p.freq * TRACE_SECONDS),
      { scope: appScope },
    );

    return { params: slice.params, trace, pointsPerCycle };
  },
  import.meta.hot,
);

export type AppGraph = ReturnType<typeof graph>;

const kit = agentToolkit(appScope.name);
registerStandardTools(kit, { scopes: [appScope] });
