/**
 * graph.ts — the cell graph (playbook layer 2): every dataflow in the app,
 * notebook-style, plus the agent tool surface. Cells wrap the pure functions
 * of layer 1 with reality — time, failure, cancellation, streaming.
 *
 * This module is *disposable logic*. `hotCellGraph` builds the graph from the
 * durable roots in store.ts and, on a hot edit, disposes the old graph and
 * swaps in a new one — the sliders keep their positions and every cell
 * recomputes from the roots. Components read `graph().someCell` through the
 * stable accessor it returns, so they can never hold a stale cell reference.
 *
 * Add your cells inside the builder — `cell(deps, compute)` handles aborts,
 * progress, and streaming — and test them headless with
 * @habemus-papadum/aiui-viz/testing (one `whenReady` probe per input).
 */
import { oscillatorCells } from "@habemus-papadum/aiui-oscillator";
import { agentToolkit, cell, hotCellGraph, registerStandardTools } from "@habemus-papadum/aiui-viz";
import { left, leftScope, right, rightScope } from "./store";

// --- the graph: rebuilt over the durable roots on every hot edit --------------
//
// The slice contributes its cells to THIS app's one graph: `oscillatorCells`
// is called inside the builder (a slice never owns the hotCellGraph ritual —
// that is bound to this module's import.meta.hot). The `lissajous` cell then
// composes ACROSS the two instances — reading "left/trace" and "right/trace"
// like any other cells — which is the payoff of slices being plain functions.

/** The current graph — a stable accessor that survives hot swaps. */
export const graph = hotCellGraph(
  "app",
  () => {
    const l = oscillatorCells(leftScope, left);
    const r = oscillatorCells(rightScope, right);

    /** The two oscillators plotted against each other: x = left, y = right. */
    const lissajous = cell(
      () => ({ x: l.trace(), y: r.trace() }),
      ({ x, y }) => {
        const n = Math.min(x.length, y.length);
        const points = new Float64Array(n * 2);
        for (let i = 0; i < n; i++) {
          points[i * 2] = x[i];
          points[i * 2 + 1] = y[i];
        }
        return points;
      },
    );

    return { leftTrace: l.trace, rightTrace: r.trace, lissajous };
  },
  // Passed, not read here: `import.meta.hot` is bound to THIS module, and a
  // library can't self-accept on our behalf. See hotCellGraph's docs.
  import.meta.hot,
);

/** The graph's shape, inferred — components can type against it. */
export type AppGraph = ReturnType<typeof graph>;

// --- the agent surface: derived from the declarations -------------------------
//
// Controls (store.ts) and actions (declared next to their features) surface
// automatically: `registerStandardTools` provides `report` (the whole picture:
// controls, cells, actions, dependency edges), `set` (validated through each
// control's own meta), `locate`, and one real tool per action. Hand-write a
// kit.registerTool(...) only for operations that are genuinely neither a value
// nor a verb-with-args. Registration is idempotent by name (HMR-safe).

const kit = agentToolkit("app");

// `locate` (element → source) and the `cells` attribution table: app-independent,
// and every aiui app should have them.
registerStandardTools(kit);
