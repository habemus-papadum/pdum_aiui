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
import type { Selection } from "@uwdata/mosaic-core";
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

function clauseCount(brush: Selection): number {
  return brush.clauses.length;
}

function round(x: number, digits: number): number {
  const p = 10 ** digits;
  return Math.round(x * p) / p;
}

function registerTools(): void {
  const kit = agentToolkit("seismos");
  const { registerTool, registerReporter } = kit;
  const brush = store.brush;
  // The derived surface: report/set/locate (+ actions — one `set-<dim>` tool
  // per filter dimension declared in store.ts, the four view verbs from
  // selectionViews, and clear-filters below). The old hand-written set-filter
  // tool dissolved into the dims — declaring IS exposing.
  registerStandardTools(kit);

  /** Remove every cross-filter clause — filter dimensions, map/histogram
   * brushes, and facet menus alike. Returns the clause count left (0). */
  action({
    scope: seismosScope,
    name: "clear-filters",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: () => ({ activeClauses: store.clearFilters() }),
  });

  // The per-component companion: `clear-selection { name }` — one dimension
  // ("mag") or one component ("seismos/map", the whole 2-D box) — clause and
  // visual both; everything else stays. Same code path as the inspector's ✕.
  registerClearSelection(seismosScope);

  registerTool({
    name: "suggest-mc",
    description:
      "Return the data-driven completeness magnitude (max-curvature of the filtered FMD); does not apply it.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: () => ({ mcSuggested: mcMaxCurvature(store.histo()) }),
  });

  registerTool({
    name: "query",
    description:
      "Run a bounded, read-only SQL SELECT against the `quakes` table (columns: time, year, longitude, latitude, depth, mag, magtype, type, depth_class). Row-capped.",
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
  registerReporter("rowsFiltered", () => seismosGraph().grStats().rowsFiltered ?? null);
  registerReporter("activeClauses", () => clauseCount(brush));
  // Attributed clauses (dim | component | unknown, with fields + SQL) — the
  // same rows the on-page SelectionInspector renders; one computation, two
  // audiences.
  registerReporter("filters", () => {
    return selectionInspectorModel({ signal: store.brushSignal, scope: seismosScope }).clauses;
  });
  // What COULD filter here, grouped by column: each group lists the declared
  // dimensions and the live components (map/histogram brushes, menus) that
  // speak it. One member = an unambiguous target for a spoken filter;
  // several = worth a clarifying question.
  registerReporter("capabilities", () => {
    return selectionInspectorModel({ signal: store.brushSignal, scope: seismosScope }).capabilities;
  });
  // The declared dimensions with their semantic values (null = inactive but
  // available) — the agent-facing view of what set-<dim> can move.
  registerReporter("dimensions", () => selectionDimReport(seismosScope));
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
