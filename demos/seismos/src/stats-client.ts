/**
 * stats-client.ts — a custom MosaicClient that keeps a *magnitude histogram of
 * the current cross-filter selection* live.
 *
 * This is the seam where the science meets Mosaic. The vgplot views publish
 * their brushes into one crossfilter `Selection`; the coordinator recomputes
 * each client's filtered query when that selection changes. A plain histogram
 * mark would just draw bars — but we also want the *numbers* behind the bars
 * (the b-value, the counts) in cells and stat tiles. So we register our own
 * client: the coordinator calls `query(filter)` with the selection's predicate
 * (a crossfilter Selection excludes only a client's own clause — this client
 * has none, so it sees the whole selection) and hands the result to
 * `queryResult`, which we forward to the reactive graph as a plain `MagBin[]`.
 *
 * The result drives gr.ts (pure math) and the Gutenberg–Richter view; the graph
 * treats this client as a durable data source it merely reads.
 */
import { MosaicClient, type Selection } from "@uwdata/mosaic-core";
import { count, Query, sql } from "@uwdata/mosaic-sql";
import type { MagBin } from "./gr";

/** Rows arrive as an Arrow/flechette table (has toArray) or a plain array. */
function rows(data: unknown): Array<Record<string, unknown>> {
  const t = data as { toArray?: () => Array<Record<string, unknown>> };
  if (typeof t?.toArray === "function") return t.toArray();
  return Array.from(data as Iterable<Record<string, unknown>>);
}

export class MagHistogramClient extends MosaicClient {
  private readonly table: string;
  private readonly onResult: (bins: MagBin[]) => void;

  constructor(table: string, filterBy: Selection, onResult: (bins: MagBin[]) => void) {
    super(filterBy);
    this.table = table;
    this.onResult = onResult;
  }

  /**
   * Force a fresh query on every selection change rather than serving from the
   * coordinator's pre-aggregated index. The index optimizes filterStable
   * clients over *interval* (continuous) crossfilter dimensions, but does not
   * apply *point* clauses (an event-type or depth-class equality) to this
   * client — so with the default (stable) path a categorical filter leaves the
   * histogram unchanged. Our query is a single cheap aggregate over 270k rows in
   * DuckDB-WASM (milliseconds), so re-running it per brush is the correct trade
   * and makes every clause kind filter identically.
   */
  get filterStable(): boolean {
    return false;
  }

  /**
   * Incremental frequency–magnitude distribution over the filtered rows.
   * Magnitudes are reported to 0.1, so `round(mag, 1)` bins are exact bin
   * centers — no information lost, and gr.ts can compute the mean magnitude
   * from the bins directly.
   */
  query(filter: Parameters<MosaicClient["query"]>[0] = []) {
    const mbin = sql`round(mag, 1)`;
    return Query.from(this.table)
      .select({ mbin, n: count() })
      .where(filter ?? [])
      .groupby(mbin)
      .orderby(mbin);
  }

  queryResult(data: unknown): this {
    const bins: MagBin[] = [];
    for (const row of rows(data)) {
      const mag = Number(row.mbin);
      const n = Number(row.n);
      if (Number.isFinite(mag) && n > 0) bins.push({ mag, count: n });
    }
    this.onResult(bins);
    return this;
  }
}
