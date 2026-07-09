/**
 * graph.ts — the cell graph (every dataflow in the app, notebook-style) and
 * the agent tool surface, in one place.
 *
 * This module is *disposable logic*. `hotCellGraph` builds the graph from the
 * durable roots in store.ts and, on a hot edit, disposes the old graph and
 * swaps in a new one — every parameter keeps its value and every cell
 * recomputes from the roots. Components read `graph().someCell` through the
 * stable accessor it returns, so they never hold a stale cell reference.
 *
 * The graph is empty. This is where the app's fetches, workers, and derived
 * data go: `cell(deps, compute)` handles aborts, progress, and streaming, and
 * `<CellView of={…}>` renders one with loading/error chrome and the attribution
 * stamps for free. See the frontend user guide and the gallery demo for worked
 * examples.
 */
import {
  agentToolkit,
  type Cell,
  hotCellGraph,
  registerStandardTools,
} from "@habemus-papadum/aiui-viz";

/**
 * The app's cells. Replace this index signature with named fields as you add
 * them — `interface AppGraph { temperature: Cell<Series> }` — so components
 * read `graph().temperature` with a real type.
 */
export type AppGraph = Record<string, Cell<unknown>>;

// --- the graph: rebuilt over the durable roots on every hot edit --------------

/** The current graph — a stable accessor that survives hot swaps. */
export const graph = hotCellGraph<AppGraph>(
  "app",
  () => {
    // const thing = cell(() => ({ …deps }), async (deps, ctx) => { … });
    return {} satisfies AppGraph;
  },
  // Passed, not read here: `import.meta.hot` is bound to THIS module, and a
  // library can't self-accept on our behalf. See hotCellGraph's docs.
  import.meta.hot,
);

// --- agent tools: the app's operations, exposed as they are built ---------------
//
// Every operation a user can perform should have a tool twin, so the agent
// (your future self) can drive and inspect the app instead of guessing at it.
// Register each one next to the capability it exposes. Registration is
// idempotent by name, so a hot edit replaces rather than duplicates.

const kit = agentToolkit("app");

// `locate` (element → source) and the `cells` attribution table: app-independent,
// and every aiui app should have them.
registerStandardTools(kit);
