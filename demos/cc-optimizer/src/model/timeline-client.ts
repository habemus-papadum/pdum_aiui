/**
 * timeline-client.ts — the session graph as a first-class Mosaic client.
 *
 * This is the seam where the timeline meets the crossfilter. It is a real
 * `MosaicClient`, not a chart that happens to read a signal, and it plays both
 * roles a crossfilter participant can play:
 *
 *  - **Consumer.** `filterBy` is the shared `Selection`; the coordinator calls
 *    `query(predicate)` whenever anyone's clause changes and hands the rows to
 *    `queryResult`, which pushes them into a durable Solid signal. From there
 *    it is pure Solid — layout (timeline.ts) and SVG.
 *  - **Producer.** Brushing the time axis calls `publish`, which puts a
 *    `clauseInterval` into the same Selection. Every other client re-queries.
 *
 * Why a custom client rather than stock vgplot marks: the vertical position of
 * every mark is a *lane*, and lanes are computed by packing the result set that
 * comes back — they are a property of the query result, not a column in it. A
 * mark's `y` channel can only name a column or a constant, so a stock mark
 * would need the lane materialised in SQL (an interval-graph coloring, i.e. a
 * recursive CTE re-run on every brush) and would still have nowhere to put the
 * fork beziers, whose endpoints are two different rows' lanes. `queryResult` is
 * the hook that exists precisely for "I will do my own rendering", so that is
 * the one we use.
 *
 * One query, three row kinds, one round trip — `kind` discriminates sessions,
 * agents, and fork edges. Expanding or collapsing anything is pure layout and
 * never comes back here.
 */
import { clauseInterval, MosaicClient, type Selection } from "@uwdata/mosaic-core";
import { count, Query, sql, sum } from "@uwdata/mosaic-sql";
import type { ForkEdgeInput, TimelineSpan } from "./timeline";

/** What one query delivers: everything the layout needs, already parsed. */
export interface TimelineData {
  spans: TimelineSpan[];
  forks: ForkEdgeInput[];
}

/** The unfiltered extent of the corpus, resolved once in `prepare`. */
export interface TimelineDomain {
  t0: number;
  t1: number;
}

/** Arrow/flechette table or plain array — the same shape seismos handles. */
function rows(data: unknown): Array<Record<string, unknown>> {
  const t = data as { toArray?: () => Array<Record<string, unknown>> };
  if (typeof t?.toArray === "function") return t.toArray();
  return Array.from((data ?? []) as Iterable<Record<string, unknown>>);
}

/** DuckDB hands INT64 back as BigInt, which poisons every later `new Date`. */
const n = (v: unknown): number => (typeof v === "bigint" ? Number(v) : Number(v ?? 0));
const s = (v: unknown): string | null => (v == null ? null : String(v));

/**
 * The union arm shapes must line up positionally, and an untyped `NULL` in one
 * arm makes DuckDB guess. Naming the type once keeps the three arms compatible.
 */
const NULL_TEXT = sql`NULL::VARCHAR`;

export interface TimelineClientOptions {
  /** The crossfilter this client both reads and publishes into. */
  filterBy: Selection;
  onResult: (data: TimelineData) => void;
  onPending?: () => void;
  onError?: (error: Error) => void;
  onDomain?: (domain: TimelineDomain) => void;
}

export class SessionTimelineClient extends MosaicClient {
  private readonly opts: TimelineClientOptions;
  /** The last range published, so the view can render its own brush. */
  private range: [number, number] | null = null;

  constructor(opts: TimelineClientOptions) {
    super(opts.filterBy);
    this.opts = opts;
  }

  /**
   * Never `true` here, and not merely as a precaution.
   *
   * `filterStable` promises the coordinator that changing the filter does not
   * change the client's groupby domain — which is exactly what this client's
   * filter *does*: the group keys ARE the surviving sessions and agents, so a
   * narrower brush returns a different (smaller) set of rows, and lanes repack
   * around it. Claiming stability would let the pre-aggregation index serve a
   * fixed set of groups and the timeline would stop losing and gaining tracks.
   * (seismos hit the milder version of this: its histogram kept a fixed
   * magnitude domain and the index silently dropped point clauses. See
   * demos/seismos/src/NOTES.md, finding 1.)
   */
  get filterStable(): boolean {
    return false;
  }

  /**
   * Resolve the corpus's full time extent *before* the first filtered query.
   *
   * The x scale must be the unfiltered domain: it is the axis the user brushes
   * on, and rescaling it to the brush would make every drag chase its own
   * tail. `prepare` is the lifecycle slot for exactly this — one metadata query
   * the coordinator awaits before it starts calling `query`. (In Mosaic 0.28
   * `prepare` replaced the older `fields`/`fieldInfo` pair; there is no
   * `fieldInfo` hook to hang this on any more.)
   */
  async prepare(): Promise<void> {
    if (!this.opts.onDomain) return;
    const q = Query.from("turns").select({
      t0: sql`epoch_ms(min(ts))`,
      t1: sql`epoch_ms(max(ts))`,
    });
    const result = rows(await this.coordinator!.query(q))[0];
    if (result) this.opts.onDomain({ t0: n(result.t0), t1: n(result.t1) });
  }

  /**
   * Sessions, agents and fork edges in one pass over the filtered turns.
   *
   * Everything aggregates from `turns` rather than the pre-rolled `sessions`
   * table, and that is a crossfilter requirement, not a preference: a clause
   * published by any other view is a predicate over *turn* columns
   * (`ts`, `project`, `model`, `agentType`, …). Applied to `sessions`, whose
   * columns are `firstTs`/`lastTs`, most of them would not resolve at all. One
   * filtered CTE, three arms off it, and every clause anyone can raise lands
   * somewhere it makes sense.
   */
  query(filter: Parameters<MosaicClient["query"]>[0] = []) {
    const t = Query.from("turns")
      .select("*")
      .where(filter ?? []);

    const sessions = Query.from("t")
      .select({
        kind: sql`'session'`,
        id: "sessionId",
        project: sql`any_value(project)`,
        parentId: NULL_TEXT,
        t0: sql`epoch_ms(min(ts))`,
        t1: sql`epoch_ms(max(ts))`,
        nTurns: count(),
        cost: sum("costTotal"),
        agentType: NULL_TEXT,
        context: sql`'main'`,
      })
      .groupby("sessionId");

    // An agent's span is its own turns; its parent is the session that paid for
    // them. This is what makes subagent and workflow launches visible without
    // any lineage table — `agentId` is already the per-instance identity.
    const agents = Query.from("t")
      .select({
        kind: sql`'agent'`,
        id: "agentId",
        project: sql`any_value(project)`,
        parentId: sql`any_value(sessionId)`,
        t0: sql`epoch_ms(min(ts))`,
        t1: sql`epoch_ms(max(ts))`,
        nTurns: count(),
        cost: sum("costTotal"),
        agentType: sql`any_value(agentType)`,
        context: sql`any_value(context)`,
      })
      .where(sql`context <> 'main' AND agentId IS NOT NULL`)
      .groupby("agentId");

    // Session→session forks, best-effort. A turn whose containing file is not
    // its origin session was COPIED there by a fork, so `fileSessionId` is the
    // child and `sessionId` the parent; `max(ts)` over those inherited turns is
    // the point in the parent's timeline that was branched. Best-effort because
    // dedup keeps only ONE copy of each billed turn and which file it came from
    // is arbitrary — the parent's copy usually wins, and then the fork leaves no
    // trace here at all. The durable fix belongs in the normalizer; see the
    // proposal in this app's README.
    const forks = Query.from("t")
      .select({
        kind: sql`'fork'`,
        id: "fileSessionId",
        project: sql`any_value(project)`,
        parentId: "sessionId",
        t0: sql`epoch_ms(max(ts))`,
        t1: sql`epoch_ms(max(ts))`,
        nTurns: count(),
        cost: sql`0.0`,
        agentType: NULL_TEXT,
        context: sql`'fork'`,
      })
      .where(sql`fileSessionId IS NOT NULL AND fileSessionId <> sessionId`)
      .groupby("fileSessionId", "sessionId");

    return Query.unionAll(sessions, agents, forks).with({ t });
  }

  queryPending(): this {
    this.opts.onPending?.();
    return this;
  }

  queryError(error: Error): this {
    this.opts.onError?.(error);
    return this;
  }

  /** Split the three row kinds apart and hand the layout its inputs. */
  queryResult(data: unknown): this {
    const spans: TimelineSpan[] = [];
    const forks: ForkEdgeInput[] = [];
    for (const row of rows(data)) {
      const kind = String(row.kind);
      const id = s(row.id);
      if (!id) continue;
      if (kind === "fork") {
        const parentId = s(row.parentId);
        if (parentId && parentId !== id) {
          forks.push({ childId: id, parentId, forkTs: n(row.t0) });
        }
        continue;
      }
      spans.push({
        kind: kind === "agent" ? "agent" : "session",
        id,
        project: s(row.project) ?? "(unknown)",
        parentId: s(row.parentId),
        t0: n(row.t0),
        t1: n(row.t1),
        nTurns: n(row.nTurns),
        cost: n(row.cost),
        agentType: s(row.agentType),
        context: s(row.context) ?? "main",
      });
    }
    this.opts.onResult({ spans, forks });
    return this;
  }

  /** The range this client currently has published, if any. */
  get published(): [number, number] | null {
    return this.range;
  }

  /**
   * Publish a brushed time range into the crossfilter — or `null` to clear it.
   *
   * `clients: new Set([this])` is what keeps the timeline from filtering
   * itself: in a crossfilter a clause is excluded from the predicate handed to
   * its own source's clients, so the graph keeps every track on screen while
   * the brush narrows everyone else. Without it, dragging a brush would delete
   * the very tracks being brushed over.
   *
   * The field is `epoch_ms(ts)` rather than `ts` because the value is a number:
   * comparing a TIMESTAMP column against epoch-millisecond literals is a cast
   * away from either an error or a silent misread, and every other client here
   * already thinks in epoch ms.
   */
  publish(range: [number, number] | null): void {
    this.range = range;
    this.filterBy?.update(
      clauseInterval(sql`epoch_ms(ts)`, range, {
        source: this,
        clients: new Set([this]),
      }),
    );
  }
}

/** What the selection currently covers. */
export interface SelectionStats {
  turns: number;
  sessions: number;
  agents: number;
  cost: number;
}

/**
 * The timeline's counterpart: a second client that reports what the selection
 * covers.
 *
 * Its job is partly to be useful and partly to be *evidence*. It raises no
 * clause of its own, so in a crossfilter it sees every clause including the
 * timeline's — which makes it the readout that proves the brush propagates
 * through the coordinator rather than through a local callback. If these
 * numbers move when the timeline is dragged, the client contract is wired.
 */
export class SelectionStatsClient extends MosaicClient {
  private readonly onResult: (stats: SelectionStats) => void;

  constructor(filterBy: Selection, onResult: (stats: SelectionStats) => void) {
    super(filterBy);
    this.onResult = onResult;
  }

  /** Same reasoning as the timeline's: one scalar row, no stable group domain. */
  get filterStable(): boolean {
    return false;
  }

  query(filter: Parameters<MosaicClient["query"]>[0] = []) {
    return Query.from("turns")
      .select({
        turns: count(),
        sessions: sql`count(DISTINCT sessionId)`,
        agents: sql`count(DISTINCT agentId)`,
        cost: sum("costTotal"),
      })
      .where(filter ?? []);
  }

  queryResult(data: unknown): this {
    const row = rows(data)[0];
    this.onResult({
      turns: n(row?.turns),
      sessions: n(row?.sessions),
      agents: n(row?.agents),
      cost: n(row?.cost),
    });
    return this;
  }
}
