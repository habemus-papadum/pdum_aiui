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
import { clauseInterval, clausePoint, type Selection } from "@uwdata/mosaic-core";
import { column } from "@uwdata/mosaic-sql";
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

/**
 * Stable per-kind clause source objects (a Selection keys clauses by source
 * identity), so re-setting a kind replaces its prior clause rather than stacking.
 */
const SRC = {
  mag: { name: "agent:mag" },
  depth: { name: "agent:depth" },
  year: { name: "agent:year" },
  type: { name: "agent:type" },
  depthClass: { name: "agent:depthClass" },
  // A geographic box is two independent 1-D interval clauses. A single 2-D
  // clauseIntervals clause needs scale metadata to resolve in a crossfilter; two
  // 1-D clauseInterval clauses (like the histogram brushes) always propagate.
  regionLon: { name: "agent:regionLon" },
  regionLat: { name: "agent:regionLat" },
};

function clauseCount(brush: Selection): number {
  return brush.clauses.length;
}

function activeFilters(brush: Selection): string[] {
  return brush.clauses.map((c) => String(c.predicate ?? "")).filter((s) => s.length > 0);
}

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function round(x: number, digits: number): number {
  const p = 10 ** digits;
  return Math.round(x * p) / p;
}

function registerTools(): void {
  const kit = agentToolkit("seismos");
  const { registerTool, registerReporter } = kit;
  const brush = store.brush;
  // The derived surface: report/set/locate (+ actions, when declared). The old
  // set-mc tool dissolved into the `mc` control — declaring IS exposing.
  registerStandardTools(kit);

  registerTool({
    name: "suggest-mc",
    description:
      "Return the data-driven completeness magnitude (max-curvature of the filtered FMD); does not apply it.",
    run: () => ({ mcSuggested: mcMaxCurvature(store.histo()) }),
  });

  registerTool({
    name: "set-filter",
    description:
      "Add or replace cross-filter clauses on the shared selection (drives every view). Combine any: magnitude/depth/year ranges, an event type or depth class, or a lon/lat box. Each kind replaces its own prior clause. Read report() after a tick for updated counts.",
    params: {
      minMag: "number — lower magnitude bound",
      maxMag: "number — upper magnitude bound",
      minDepth: "number km",
      maxDepth: "number km",
      minYear: "integer",
      maxYear: "integer",
      type: "'earthquake' | 'nuclear explosion' | 'volcanic eruption' | …",
      depthClass: "'shallow' | 'intermediate' | 'deep'",
      west: "lon °",
      east: "lon °",
      south: "lat °",
      north: "lat °",
    },
    run: (args = {}) => {
      const s = store.summary();
      if (args.minMag != null || args.maxMag != null) {
        brush.update(
          clauseInterval(
            column("mag"),
            [num(args.minMag, s?.magMin ?? 0), num(args.maxMag, s?.magMax ?? 10)],
            { source: SRC.mag },
          ),
        );
      }
      if (args.minDepth != null || args.maxDepth != null) {
        brush.update(
          clauseInterval(
            column("depth"),
            [num(args.minDepth, s?.depthMin ?? 0), num(args.maxDepth, s?.depthMax ?? 800)],
            { source: SRC.depth },
          ),
        );
      }
      if (args.minYear != null || args.maxYear != null) {
        brush.update(
          clauseInterval(
            column("year"),
            [num(args.minYear, s?.yearMin ?? 1976), num(args.maxYear, s?.yearMax ?? 2024)],
            { source: SRC.year },
          ),
        );
      }
      if (typeof args.type === "string") {
        brush.update(clausePoint(column("type"), args.type, { source: SRC.type }));
      }
      if (typeof args.depthClass === "string") {
        brush.update(
          clausePoint(column("depth_class"), args.depthClass, { source: SRC.depthClass }),
        );
      }
      if (args.west != null || args.east != null) {
        brush.update(
          clauseInterval(column("longitude"), [num(args.west, -180), num(args.east, 180)], {
            source: SRC.regionLon,
          }),
        );
      }
      if (args.south != null || args.north != null) {
        brush.update(
          clauseInterval(column("latitude"), [num(args.south, -90), num(args.north, 90)], {
            source: SRC.regionLat,
          }),
        );
      }
      return { activeClauses: clauseCount(brush), filters: activeFilters(brush) };
    },
  });

  registerTool({
    name: "clear-filters",
    description: "Remove every cross-filter clause (from views, inputs, and the agent).",
    run: () => {
      for (const c of [...brush.clauses]) {
        brush.update({ ...c, value: null, predicate: null });
      }
      return { activeClauses: clauseCount(brush) };
    },
  });

  registerTool({
    name: "query",
    description:
      "Run a bounded, read-only SQL SELECT against the `quakes` table (columns: time, year, longitude, latitude, depth, mag, magtype, type, depth_class). Row-capped.",
    params: { sql: "a single SELECT/WITH statement", limit: "optional row cap (≤5000)" },
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
  registerReporter("filters", () => activeFilters(brush));
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
