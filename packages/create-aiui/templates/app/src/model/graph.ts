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
 * <aiui-scenery>
 * The starter's demo dataflow lives in scenery.ts (with scenery.test.ts as the
 * worked test example) and joins the graph through the fenced lines below, so
 * a reset deletes it without touching yours.
 * </aiui-scenery>
 */
import { agentToolkit, hotCellGraph, registerStandardTools } from "@habemus-papadum/aiui-viz";
// <aiui-scenery>
import { sceneryCells } from "./scenery";
// </aiui-scenery>
import { appScope } from "./store";

// --- the graph: rebuilt over the durable roots on every hot edit --------------

/** The current graph — a stable accessor that survives hot swaps. */
export const graph = hotCellGraph(
  appScope.name,
  () => ({
    // Your cells go here: `myCell: cell(() => ({ …deps }), async (deps, ctx) => …),`
    // <aiui-scenery>
    ...sceneryCells(),
    // </aiui-scenery>
  }),
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

// The toolkit namespace is the app's slug: tools install at window.__<slug>.
const kit = agentToolkit(appScope.name);

// `locate` (element → source) and the `cells` attribution table: app-independent,
// and every aiui app should have them.
registerStandardTools(kit);
