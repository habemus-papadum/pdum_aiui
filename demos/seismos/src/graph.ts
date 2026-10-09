/**
 * graph.ts — the seismos cell graph (playbook layer 2): the loading cell (real progress from the
 * parquet fetch), the derived Gutenberg–Richter statistics of the current
 * cross-filter selection, and the agent tool surface — all built over the
 * durable roots in store.ts and published through a durable box the UI reads.
 *
 * Disposable logic: a hot edit disposes the old graph and builds a new one over
 * the same roots. The DuckDB table, the coordinator, and the crossfilter
 * selection survive; only these cells and the tool closures are rebuilt.
 *
 * The GR stats are a plain memo over two durable signals — the histogram the
 * Mosaic stats-client keeps live (store.histo, updated by the coordinator on
 * every selection change) and the Mc control (store.mc) — piped through the pure
 * math in gr.ts. That memo is the whole reactive bridge between Mosaic's world
 * and Solid's: Mosaic writes one signal, Solid derives the rest.
 *
 * Agent tools install at window.__seismos (design-choices §6), registered here
 * beside the capabilities they expose.
 */
import {
  agentToolkit,
  type Cell,
  cell,
  hotCellGraph,
  registerStandardTools,
} from "@habemus-papadum/aiui-viz";
import { crossfilterViews, registerCrossfilterTools } from "@habemus-papadum/aiui-viz/crossfilter";
import { registerSqlTools, type SchemaViewProvider } from "@habemus-papadum/aiui-viz/duckdb";
import { type Accessor, createMemo } from "solid-js";
import {
  bValue,
  type CumPoint,
  cumulative,
  fitLine,
  type GrFit,
  type MagBin,
  mcMaxCurvature,
  totalCount,
} from "./gr";
import { type Summary, seismosScope, store } from "./store";

export interface GrStats {
  /** The filtered magnitude histogram (incremental FMD). */
  bins: MagBin[];
  /** Events in the current selection. */
  rowsFiltered: number;
  /** Cumulative curve N(≥M). */
  cumulative: CumPoint[];
  /** The maximum-likelihood fit above Mc, or null if too few complete events. */
  fit: GrFit | null;
  /** Fit-line endpoints for the log-N overlay. */
  fitLine: CumPoint[];
  /** Data-driven Mc suggestion (max-curvature of the incremental FMD). */
  mcSuggested: number | null;
}

export interface SeismosGraph {
  /** The load: instantiate DuckDB, fetch the parquet (progress), CREATE TABLE. */
  dataset: Cell<Summary>;
  /** Live Gutenberg–Richter statistics of the current cross-filter selection. */
  grStats: Accessor<GrStats>;
}

// --- the graph: rebuilt over the durable roots on every hot edit --------------

/** The current graph — a stable accessor that survives hot swaps. */
export const seismosGraph = hotCellGraph<SeismosGraph>(
  "seismos",
  () => {
    // ---- the loading cell: drives the durable, memoized load with progress ---
    const dataset = cell<Record<string, never>, Summary>(
      () => ({}),
      (_deps, ctx) => store.ensureLoaded(ctx.progress),
      { scope: seismosScope },
    );

    // ---- derived Gutenberg–Richter statistics of the filtered selection ------
    // store.histo is written by the Mosaic stats-client whenever the crossfilter
    // selection changes; store.mc is the user's completeness control. Pure math.
    const grStats = createMemo<GrStats>(() => {
      const bins = store.histo();
      const mc = store.mc.get();
      const fit = bValue(bins, mc);
      const magMax = bins.length ? bins[bins.length - 1].mag : mc + 2;
      return {
        bins,
        rowsFiltered: totalCount(bins),
        cumulative: cumulative(bins),
        fit,
        fitLine: fit ? fitLine(fit, magMax) : [],
        mcSuggested: mcMaxCurvature(bins),
      };
    });

    return { dataset, grStats } satisfies SeismosGraph;
  },
  // Passed, not read here: `import.meta.hot` is bound to THIS module, and a
  // library can't self-accept on our behalf. See hotCellGraph's docs.
  import.meta.hot,
);

// --- agent tools --------------------------------------------------------------

function round(x: number, digits: number): number {
  const p = 10 ** digits;
  return Math.round(x * p) / p;
}

/**
 * The fitted sample as a schema view — `complete.quakes`, the events at or
 * above the completeness magnitude — driven by the `mc` CONTROL, not by
 * Mosaic: the proof that the DuckDB tools' view seam is generic. No
 * `subscribe`: the body is re-read before every sql/schema call, and only a
 * changed body costs a CREATE OR REPLACE.
 */
const completeView: SchemaViewProvider = {
  id: "control",
  views: (tables) =>
    tables.some((t) => t.name === "quakes")
      ? [
          {
            schema: "complete",
            name: "quakes",
            of: "quakes",
            // Schema-qualified: a bare "quakes" inside complete.quakes would
            // bind to the view itself (DuckDB's "infinite recursion").
            sql: () => `SELECT * FROM "main"."quakes" WHERE mag >= ${store.mc.get()}`,
            describe: () => ({
              provider: "control",
              control: "seismos/mc",
              mc: store.mc.get(),
              meaning:
                "events at or above the completeness magnitude Mc — the sample the " +
                "Gutenberg–Richter fit uses",
              changedBy: 'set { name: "seismos/mc", value }',
            }),
          },
        ]
      : [],
};

function registerTools(): void {
  const kit = agentToolkit("seismos", {
    brief:
      "seismos: a cross-filtered global earthquake catalog (DuckDB table `quakes`, " +
      "1976–2024) — a map, magnitude/depth/time histograms, and a Gutenberg–Richter " +
      "fit whose completeness magnitude is the `mc` control. cross-filter is the one " +
      "tool for every filter dimension (mouse brushes and menus write the same " +
      "crossfilter); report's crossfilter section lists what is active and the WHERE in " +
      "force; sql on `quakes` queries everything, on `crossfilter.quakes` the current " +
      "subset, on `complete.quakes` the fitted sample (at or above mc).",
  });
  const { registerTool, registerReporter } = kit;
  // The derived surface: report/set/locate/read-page/selection/sources/source
  // (+ the four view verbs from selectionViews). The old hand-written
  // set-filter tool dissolved into the dims (2026-08-12), and the per-dim
  // set-<dim> tools into ONE cross-filter tool (2026-10-09): declaring IS
  // exposing, and one verb carries every dimension.
  registerStandardTools(kit);

  // The cross-filter surface: `cross-filter { set, clear }` over every
  // dimension store.ts declares, `reset-cross-filters` (dims first — their
  // VALUES too — then every producer's clause, brushes and facet menus
  // included, through Selection.reset so visuals clear), and the
  // `crossfilter` report section (predicate, per-table WHERE, views, the
  // dimensions, the attributed clauses, the capabilities).
  registerCrossfilterTools(kit, { scope: seismosScope, selection: store.brush });

  registerTool({
    name: "suggest-mc",
    description:
      "Return the data-driven completeness magnitude (max-curvature of the filtered FMD); does not apply it.",
    kind: "read",
    group: "app",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: () => ({ mcSuggested: mcMaxCurvature(store.histo()) }),
  });

  // The agent's `sql` + `schema` tools over the dedicated read connection —
  // the library's, with the table list introspected into the tool's usage
  // once the catalog is loaded — plus two schema views: the cross-filter's
  // filtered twin of `quakes` (the Mosaic provider: it also hands the table's
  // columns to the router), and the fitted sample above Mc (a control-driven
  // view that owes Mosaic nothing).
  registerSqlTools(kit, {
    runner: store.sqlRunner,
    views: [crossfilterViews({ selection: store.brush, scope: seismosScope }), completeView],
  });

  registerReporter("loadState", () => store.loadState());
  registerReporter("rowsTotal", () => store.summary()?.rowsTotal ?? null);
  registerReporter("rowsFiltered", () => seismosGraph().grStats().rowsFiltered ?? null);
  registerReporter("mc", () => store.mc.get());
  registerReporter("bValue", () => {
    const fit = seismosGraph().grStats().fit;
    return fit
      ? {
          b: round(fit.b, 3),
          sigmaB: round(fit.sigmaB, 3),
          a: round(fit.a, 3),
          mc: fit.mc,
          nComplete: fit.nComplete,
        }
      : null;
  });
  registerReporter("summary", () => store.summary() ?? null);
}

registerTools(); // idempotent by name — re-registration replaces
