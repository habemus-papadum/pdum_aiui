/**
 * graph.ts — the wine cell graph (playbook layer 2): the loading cell (real
 * progress from the two parquet downloads) plus the agent tool surface, built
 * over the durable roots in store.ts. Disposable logic: a hot edit disposes
 * and rebuilds this over the surviving DuckDB table, coordinator, and
 * crossfilter.
 *
 * The agent surface is mostly derived: ONE `cross-filter` tool over every
 * filter dimension declared in store.ts (points, price, country, variety,
 * the projx/projy region pair that draws the embedding map's box, and the
 * lon/lat pair for the world map) plus
 * `reset-cross-filters` and the `crossfilter` report section
 * (`registerCrossfilterTools`), the four named-view verbs, the library's
 * `sql`/`schema` tools over the dedicated read connection
 * (`registerSqlTools`, with the cross-filter's `crossfilter.wine` view), and
 * the reporters below.
 */
import {
  agentToolkit,
  type Cell,
  cell,
  hotCellGraph,
  registerStandardTools,
} from "@habemus-papadum/aiui-viz";
import { crossfilterViews, registerCrossfilterTools } from "@habemus-papadum/aiui-viz/crossfilter";
import { registerSqlTools } from "@habemus-papadum/aiui-viz/duckdb";
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
  const kit = agentToolkit(appScope.name, {
    brief:
      "wine: wine reviews (DuckDB table `wine`, with `province_geo` for the regions) " +
      "on two linked maps — an embedding atlas of the review text and a geographic " +
      "map of provinces — plus histograms of points and price and menus for country " +
      "and variety. cross-filter is the one tool for every filter dimension (mouse " +
      "brushes, the lasso and the menus write the same crossfilter): projx+projy box " +
      "the embedding, lon+lat box the map, the rest filter one column; report's " +
      "crossfilter section lists what is active and the WHERE in force; sql on `wine` " +
      "queries everything, on `crossfilter.wine` the current subset.",
  });
  const { registerReporter } = kit;
  registerStandardTools(kit);

  // The cross-filter surface: `cross-filter { set, clear }` over every
  // dimension store.ts declares (clear takes a dimension or a component —
  // "wine/embedding" clears the whole region box), `reset-cross-filters`,
  // and the `crossfilter` report section.
  registerCrossfilterTools(kit, { scope: appScope, selection: store.brush });

  // The agent's `sql` + `schema` tools over the dedicated read connection —
  // the library's; the `wine` and `province_geo` tables are introspected into
  // the tool's usage once loaded — with the cross-filter's filtered twin of
  // `wine` as a schema view.
  registerSqlTools(kit, {
    runner: store.sqlRunner,
    views: [crossfilterViews({ selection: store.brush, scope: appScope })],
  });

  registerReporter("loadState", () => store.loadState());
  registerReporter("rowsTotal", () => store.summary()?.rowsTotal ?? null);
  registerReporter("rowsFiltered", () => store.stats()?.rows ?? null);
  registerReporter("varieties", () => store.summary()?.varieties ?? null);
  registerReporter("summary", () => store.summary() ?? null);
}

registerTools(); // idempotent by name — re-registration replaces
