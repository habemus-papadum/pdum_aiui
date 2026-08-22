/**
 * stats-client.ts — a custom MosaicClient keeping the headline numbers of the
 * current cross-filter selection live (the seismos stats-client pattern): the
 * coordinator re-runs `query(filter)` on every selection change and the
 * result lands in one durable Solid signal the stat tiles read. This client
 * publishes no clauses of its own, so a crossfilter selection shows it the
 * WHOLE filter state.
 */
import { MosaicClient, type Selection } from "@uwdata/mosaic-core";
import { count, Query, sql } from "@uwdata/mosaic-sql";

export interface SelectionStats {
  rows: number;
  avgPoints: number | null;
  medianPrice: number | null;
}

function firstRow(data: unknown): Record<string, unknown> | undefined {
  const t = data as { toArray?: () => Array<Record<string, unknown>> };
  const arr =
    typeof t?.toArray === "function"
      ? t.toArray()
      : Array.from(data as Iterable<Record<string, unknown>>);
  return arr[0];
}

const num = (v: unknown): number | null => {
  const n = typeof v === "bigint" ? Number(v) : Number(v);
  return Number.isFinite(n) ? n : null;
};

export class SelectionStatsClient extends MosaicClient {
  private readonly table: string;
  private readonly onResult: (stats: SelectionStats) => void;

  constructor(table: string, filterBy: Selection, onResult: (stats: SelectionStats) => void) {
    super(filterBy);
    this.table = table;
    this.onResult = onResult;
  }

  /** Skip the pre-aggregated index: it silently drops POINT clauses (a
   * variety toggle, the country menu) for stable clients — the measured
   * seismos finding. One aggregate over ~120k rows is milliseconds. */
  get filterStable(): boolean {
    return false;
  }

  query(filter: Parameters<MosaicClient["query"]>[0] = []) {
    return Query.from(this.table)
      .select({
        n: count(),
        avg_points: sql`avg(points)`,
        median_price: sql`median(price)`,
      })
      .where(filter ?? []);
  }

  queryResult(data: unknown): this {
    const r = firstRow(data);
    this.onResult({
      rows: num(r?.n) ?? 0,
      avgPoints: num(r?.avg_points),
      medianPrice: num(r?.median_price),
    });
    return this;
  }
}
