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
 * named-view verbs, `clear-selection`, and the reporters below. `query` is
 * the one bespoke tool — bounded read-only SQL over the wine table.
 */
import {
  action,
  agentToolkit,
  type Cell,
  cell,
  hotCellGraph,
  registerStandardTools,
} from "@habemus-papadum/aiui-viz";
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
  const { registerTool, registerReporter } = kit;
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

  registerTool({
    name: "query",
    description:
      "Run a bounded, read-only SQL SELECT against the `wine` table (columns: id, title, " +
      "country, province, region_1, region_2, winery, description, points, price, variety, " +
      "designation, variety_class, variety_cat, projection_x, projection_y, latitude, " +
      "longitude, eq_x, eq_y) or the `province_geo` lookup (country, province, lat, lon). " +
      "Row-capped.",
    inputSchema: {
      type: "object",
      properties: {
        sql: { type: "string", description: "a single SELECT/WITH statement" },
        limit: { type: "number", description: "row cap (≤5000, default 1000)" },
      },
      required: ["sql"],
      additionalProperties: false,
    },
    run: (args) => {
      const sql = String(args?.sql ?? "");
      const limit = typeof args?.limit === "number" ? args.limit : 1000;
      return store.runQuery(sql, limit);
    },
  });

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
