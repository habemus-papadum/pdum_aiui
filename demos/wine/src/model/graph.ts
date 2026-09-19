/**
 * graph.ts — the wine cell graph (playbook layer 2): the loading cell (real
 * progress from the two parquet downloads) plus the agent tool surface, built
 * over the durable roots in store.ts. Disposable logic: a hot edit disposes
 * and rebuilds this over the surviving DuckDB table, coordinator, and
 * crossfilter.
 *
 * The agent surface is mostly derived: one `set-<dim>` tool per filter
 * dimension declared in store.ts (points, price, country, variety, and the
 * projx/projy region pair that draws the embedding map's box), the four
 * named-view verbs, `clear-selection`, the library's `sql`/`schema` tools
 * over the dedicated read connection (`registerSqlTools`), and the reporters
 * below.
 */
import {
  action,
  agentToolkit,
  type Cell,
  cell,
  hotCellGraph,
  registerStandardTools,
} from "@habemus-papadum/aiui-viz";
import { registerSqlTools } from "@habemus-papadum/aiui-viz/duckdb";
import {
  registerClearSelection,
  selectionDimReport,
} from "@habemus-papadum/aiui-viz/mosaic-selection";
import { selectionInspectorModel } from "@habemus-papadum/aiui-viz/selection-inspector";
import { appScope, type Summary, store } from "./store";

export interface WineGraph {
  /** The load: fetch both parquets (progress), DuckDB, CREATE TABLE wine. */
  dataset: Cell<Summary>;
}

// --- the graph: rebuilt over the durable roots on every hot edit --------------

/** The current graph — a stable accessor that survives hot swaps. */
export const graph = hotCellGraph<WineGraph>(
  appScope.name,
  () => {
    const dataset = cell<Record<string, never>, Summary>(
      () => ({}),
      (_deps, ctx) => store.ensureLoaded(ctx.progress),
      { scope: appScope },
    );
    return { dataset } satisfies WineGraph;
  },
  // Passed, not read here: `import.meta.hot` is bound to THIS module.
  import.meta.hot,
);

/** The graph's shape, inferred — components can type against it. */
export type AppGraph = ReturnType<typeof graph>;

// --- agent tools --------------------------------------------------------------

function registerTools(): void {
  const kit = agentToolkit(appScope.name);
  const { registerReporter } = kit;
  registerStandardTools(kit);

  /** Remove every cross-filter clause — dimensions, the map's region, the
   * histogram brushes, the variety toggle, and the country menu alike. */
  action({
    scope: appScope,
    name: "clear-filters",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: () => ({ activeClauses: store.clearFilters() }),
  });

  // `clear-selection { name }` — one dimension ("points") or one component
  // ("wine/embedding", the whole region box); clause and visual both.
  registerClearSelection(appScope);

  // The agent's `sql` + `schema` tools over the dedicated read connection —
  // the library's; the `wine` and `province_geo` tables are introspected into
  // the tool's usage once loaded (the hand-typed column list is gone).
  registerSqlTools(kit, { runner: store.sqlRunner });

  registerReporter("loadState", () => store.loadState());
  registerReporter("rowsTotal", () => store.summary()?.rowsTotal ?? null);
  registerReporter("rowsFiltered", () => store.stats()?.rows ?? null);
  registerReporter("varieties", () => store.summary()?.varieties ?? null);
  // Attributed clauses — the same rows the on-page SelectionInspector renders.
  registerReporter("filters", () => {
    return selectionInspectorModel({ signal: store.brushSignal, scope: appScope }).clauses;
  });
  // What COULD filter here, grouped by column (dims + live components).
  registerReporter("capabilities", () => {
    return selectionInspectorModel({ signal: store.brushSignal, scope: appScope }).capabilities;
  });
  // The declared dimensions with their semantic values (null = inactive).
  registerReporter("dimensions", () => selectionDimReport(appScope));
  registerReporter("summary", () => store.summary() ?? null);
}

registerTools(); // idempotent by name — re-registration replaces
