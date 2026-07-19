/**
 * graph.ts — the cell graph (playbook layer 2) and the agent tool surface.
 *
 * There is one cell: `stats`. It reads the current turn's points (live while
 * drawing, frozen once settled — see store.ts's {@link turnPoints}) and runs
 * the pure {@link summarize} over them. It recomputes as the pen moves and
 * freezes when the stroke settles, exactly tracking the turn. `null` when the
 * stroke is too short to measure — the panel shows a prompt instead.
 *
 * `hotCellGraph` rebuilds this over the durable roots on every hot edit, so the
 * cell is edited freely without disturbing the surface or the drawing.
 */

import {
  action,
  agentToolkit,
  cell,
  hotCellGraph,
  registerStandardTools,
} from "@habemus-papadum/aiui-viz";
import { type CircleStats, summarize } from "./circle";
import { paper, resetTurn, turnPhase, turnPoints } from "./store";

/** Build the graph — exported so headless tests build it inside `cellHarness`. */
export function buildGraph() {
  return {
    /** The live measurement of the current turn's stroke. `null` until there
     * are enough points to fit a circle. */
    stats: cell(
      () => ({ points: turnPoints(), phase: turnPhase.get() }),
      ({ points }): CircleStats | null => summarize(points),
    ),
  };
}

/** The current graph — a stable accessor that survives hot swaps. */
export const graph = hotCellGraph("circle", buildGraph, import.meta.hot);

/** The graph's shape, inferred — components can type against it. */
export type AppGraph = ReturnType<typeof graph>;

// --- the agent surface --------------------------------------------------------

const kit = agentToolkit("circle");

/** Clear the paper and reset the turn — the ink pops away and the statistics
 * panel returns to its prompt. (The controls `fadeSeconds` and `brushSize`, and
 * the `stats` cell, surface automatically through `report`/`set`.) */
action({
  name: "clear",
  description: "Erase the drawing and reset the measured statistics to empty.",
  run: () => {
    paper.clearAnimated();
    resetTurn();
  },
});

registerStandardTools(kit);
