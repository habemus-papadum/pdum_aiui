/**
 * store.ts — the durable roots of the app (the state side of playbook layer 2),
 * and where the **control surface** is declared: the independent variables a
 * user moves through widgets and an agent moves through the derived `set` tool.
 *
 * `control({ value, … })` needs no name and no description here — the aiui
 * compiler injects the name from the binding and lifts the description from
 * the doc comment above it (so write real doc comments: they become the editor
 * tooltip AND the agent-facing registry text). Constraints (`min`/`max`/`step`/
 * `unit`/`options`) live in the declaration, and every write — slider,
 * keyboard, agent — validates through them in one place. Controls are durable:
 * a hot edit never resets what the user set; renaming a binding DOES reset its
 * state (pass an explicit `{ name }` to rename without that).
 *
 * State that is NOT part of the surface (engines, workers, canvases, history
 * rings, transient bookkeeping) uses `durableSignal()`/`durable()` instead —
 * the surface is curated, not automatic.
 *
 * The companion rule: this file is the guarded, rarely-edited wiring; the cell
 * graph (graph.ts) and the components (ui/) are the disposable logic edited
 * constantly. Note that editing this file forces a full reload — it is
 * everything's ancestor — so avoid it while a live run matters.
 */

import type { AsyncDuckDB, AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { control, scope } from "@habemus-papadum/aiui-viz";
import { clausePoints } from "@uwdata/mosaic-core";
import { Coordinator, Selection, wasmConnector } from "@uwdata/vgplot";
// Asset imports, not public/ fetches: these resolve from THIS package, so the
// data travels with the demo into any consumer's build.
import agentRunsUrl from "../data/agentRuns.parquet?url";
import eventsUrl from "../data/events.parquet?url";
import forkEdgesUrl from "../data/forkEdges.parquet?url";
import imagesUrl from "../data/images.parquet?url";
import lineagesUrl from "../data/lineages.parquet?url";
import sessionsUrl from "../data/sessions.parquet?url";
import toolCallsUrl from "../data/toolCalls.parquet?url";
import turnsUrl from "../data/turns.parquet?url";
import { BUNDLES, fetchWithProgress, instantiateDuckDB } from "../duckdb";
import {
  type SelectionStats,
  SelectionStatsClient,
  SessionTimelineClient,
  type TimelineData,
  type TimelineDomain,
} from "./timeline-client";

/**
 * The app's instance scope: ONE slug qualifying every declaration — controls
 * ("ledger/petals"), durable keys, cells, actions — and naming the
 * graph key and the agent toolkit. Thread it through everything you declare
 * (`control({ scope: appScope, … })`, `appScope.durable(…)`,
 * `cell(deps, compute, { scope: appScope })`, `action({ scope: appScope, … })`):
 * it is what lets this app share a document with other aiui apps — mounted in
 * a gallery shell, or composed as a library — without colliding on the
 * window-global registries. See the user guide's "Composing bigger apps".
 */
export const appScope = scope("cc-optimizer");

/**
 * Where the line falls between "thinking" and "went to lunch", in minutes.
 *
 * A control rather than a constant on purpose: duty cycle is the headline
 * session statistic and it moves a great deal with this threshold, so the
 * reader sets it rather than inheriting someone's guess.
 */
export const idleGapMinutes = control({
  scope: appScope,
  value: 30,
  min: 1,
  max: 240,
  step: 1,
  unit: "min",
});

/** The five grains every version of the normalizer writes. */
export const TABLES = {
  turns: turnsUrl,
  toolCalls: toolCallsUrl,
  events: eventsUrl,
  sessions: sessionsUrl,
  images: imagesUrl,
} as const;

/**
 * Grains the normalizer grew later — fork lineage and per-agent runs.
 *
 * Optional, and loaded through a `?url` import that resolves at build time, so
 * a checkout whose `src/data` predates them still boots: a missing file 404s at
 * fetch and the app carries on without that table. The alternative — listing
 * them as required — turns a stale dataset into a blank page, and the sessions
 * are the point even when the lineage is absent.
 */
export const OPTIONAL_TABLES = {
  forkEdges: forkEdgesUrl,
  agentRuns: agentRunsUrl,
  lineages: lineagesUrl,
} as const;

export type TableName = keyof typeof TABLES | keyof typeof OPTIONAL_TABLES;

/** What the normalizer recorded about the run that produced this data. */
export interface Manifest {
  generatedAt: string;
  pricing: { source: string; version: string };
  stats: {
    files: number;
    records: number;
    assistantRecords: number;
    dedupedTurns: number;
    naiveOutputTokens: number;
    dedupedOutputTokens: number;
    crossFileDuplicates: number;
    totalCost: number;
    unpricedTurns: number;
  };
  invariants: { ok: boolean; problems: string[] };
}

export interface CorpusSummary {
  turns: number;
  sessions: number;
  projects: number;
  firstTs: number;
  lastTs: number;
  totalCost: number;
  costInput: number;
  costOutput: number;
  costCacheCreate: number;
  costCacheRead: number;
}

export interface LoadProgress {
  /** 0..1 across all five tables, or null before the first byte arrives. */
  fraction: number | null;
  label: string;
}

// --- durable roots -----------------------------------------------------------

const progress = appScope.durableSignal<LoadProgress>("progress", {
  fraction: null,
  label: "starting",
});
const ready = appScope.durableSignal<boolean>("ready", false);
const loadError = appScope.durableSignal<string | null>("loadError", null);
const manifest = appScope.durableSignal<Manifest | null>("manifest", null);
const summary = appScope.durableSignal<CorpusSummary | null>("summary", null);

/**
 * The shared crossfilter. Every view publishes its brush here and reads
 * everyone else's — one Selection is what makes this a crossfilter rather than
 * several charts that happen to share a page.
 */
export const filter: Selection = appScope.durable("filter", () => Selection.crossfilter());

/**
 * The same clauses, but with nothing skipped — what a *drawn layer* should obey.
 *
 * A crossfilter deliberately hides a client's own clause from it
 * (`skip() === cross && clause.clients.has(client)`), so that a chart you are
 * brushing keeps its full data underneath and the drag has something to aim at.
 * That was the right default when a filtered-out mark disappeared. It is the
 * wrong one now that every chart draws an unfiltered base layer: the context is
 * already there in grey, so a chart applying its own brush to its coloured
 * layer is exactly what "the selection is highlighted" means — and not applying
 * it is what made brushing the scatter appear to do nothing to the scatter.
 *
 * `intersect` sets `cross: false`, so nothing is ever skipped; `include` relays
 * every clause published to the crossfilter. Marks filter by this; clauses are
 * still published to `filter`, so *other* clients keep crossfilter semantics.
 */
export const viewFilter: Selection = appScope.durable("viewFilter", () =>
  Selection.intersect({ include: filter }),
);

/** DuckDB + Mosaic live in a durable box so a hot edit never re-instantiates them. */
interface Engine {
  db: AsyncDuckDB;
  conn: AsyncDuckDBConnection;
  coordinator: Coordinator;
}
const engineBox = appScope.durable<{ engine: Engine | null; loading: Promise<void> | null }>(
  "engine",
  () => ({ engine: null, loading: null }),
);

// --- the session timeline: Mosaic's side of the crossfilter -------------------
//
// The two clients are durable roots for the same reason the coordinator is: a
// hot edit must not leave a disconnected client behind holding a stale callback.
// Everything they produce lands in a signal, and from there it is pure Solid.

const timeline = appScope.durableSignal<TimelineData>("timeline", {
  spans: [],
  forks: [],
  names: new Map(),
});
const timelineDomain = appScope.durableSignal<TimelineDomain | null>("timelineDomain", null);
const timelineBusy = appScope.durableSignal<boolean>("timelineBusy", false);
const selectionStats = appScope.durableSignal<SelectionStats | null>("selectionStats", null);
/** The time range currently published to the crossfilter — the drawn brush. */
const brushRange = appScope.durableSignal<[number, number] | null>("brushRange", null);

/**
 * Collapsed rather than expanded, so the default needs no knowledge of which
 * projects exist: an empty set means every project shows its lanes. Storing the
 * expanded set instead would need a "not yet initialised" sentinel and a first
 * -data hook to fill it in.
 */
const collapsedProjects = appScope.durableSignal<ReadonlySet<string>>(
  "collapsedProjects",
  new Set(),
);
/** Sessions whose agents are broken out onto their own sub-lanes. */
const expandedSessions = appScope.durableSignal<ReadonlySet<string>>("expandedSessions", new Set());

/**
 * The session the drill-down is looking at, or null for "pick the priciest".
 *
 * Deliberately NOT the crossfilter. The drill-down answers a different kind of
 * question from the panels above it — "what happened inside this one session"
 * rather than "how do these dimensions co-vary" — and routing it through the
 * shared Selection would make every other panel collapse to one session the
 * moment you looked at one. One explicit pointer, no filtering.
 */
const focusedSession = appScope.durableSignal<string | null>("focusedSession", null);

export function focusSession(sessionId: string | null): void {
  focusedSession.set(sessionId);
}

const clientBox = appScope.durable<{ timeline: SessionTimelineClient | null }>("clients", () => ({
  timeline: null,
}));

/** Which optional grains this dataset actually turned out to have. */
const loaded = appScope.durable<Set<string>>("loadedTables", () => new Set<string>());

/** Toggle membership without mutating in place — Solid compares by identity. */
function toggled(set: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(set);
  if (!next.delete(key)) next.add(key);
  return next;
}

export function toggleProject(project: string): void {
  collapsedProjects.set(toggled(collapsedProjects.get(), project));
}

export function toggleSession(sessionId: string): void {
  expandedSessions.set(toggled(expandedSessions.get(), sessionId));
}

export function setAllCollapsed(projects: readonly string[], collapsed: boolean): void {
  collapsedProjects.set(collapsed ? new Set(projects) : new Set<string>());
  if (collapsed) expandedSessions.set(new Set<string>());
}

/**
 * Brush a time range into the crossfilter, or clear it with `null`. The view
 * calls this on drag; the agent `brush` action calls the same path, so there is
 * one way to move the selection rather than two that can disagree.
 *
 * The range is mirrored into a signal because the *drawn* rectangle has to come
 * from here rather than from the view's own drag state: otherwise a brush set
 * or cleared by the agent tool would move the data while leaving the rectangle
 * behind, showing the reader a selection that is not the one in force.
 */
export function brushTime(range: [number, number] | null): void {
  brushRange.set(range);
  clientBox.timeline?.publish(range);
}

/**
 * Which projects are visible, or null for "all of them".
 *
 * Null rather than "every project selected" so the default needs no knowledge
 * of which projects exist — the same reasoning as `collapsedProjects`, and it
 * means no clause is published until the reader actually narrows something.
 */
const visibleProjects = appScope.durableSignal<ReadonlySet<string> | null>("visibleProjects", null);

/**
 * A stable clause source for the project filter.
 *
 * Stable identity is what makes a Selection *replace* this widget's clause
 * rather than accumulate one per click. It is a bare object because the filter
 * is not a MosaicClient — it publishes but never queries.
 */
const projectSource = { name: "project-filter" };

/**
 * Show only these projects, or `null` to show all.
 *
 * Publishes a point clause over `project`, so it composes with the timeline's
 * time interval and the scatter's time×cost box exactly like any other clause —
 * and the cell panels pick it up through `filterSql()` with no extra wiring.
 */
export function setVisibleProjects(projects: ReadonlySet<string> | null): void {
  visibleProjects.set(projects);
  filter.update(
    clausePoints(["project"], projects ? [...projects].map((p) => [p]) : null, {
      source: projectSource,
    }),
  );
}

/** Toggle one project without disturbing the others. */
export function toggleProjectVisible(project: string, all: readonly string[]): void {
  const current = visibleProjects.get() ?? new Set(all);
  const next = new Set(current);
  if (!next.delete(project)) next.add(project);
  // Back to everything selected means back to no clause at all, so the page
  // reads as unfiltered rather than as "filtered to all 12".
  setVisibleProjects(next.size === all.length ? null : next);
}

/**
 * Drop every clause AND the widget state that produced them.
 *
 * `filter.reset()` alone clears the Selection but leaves `visibleProjects`
 * holding a set, so the chips would keep showing a selection that no longer
 * filters anything. One entry point, so the two cannot drift.
 */
export function clearAllFilters(): void {
  visibleProjects.set(null);
  brushRange.set(null);
  filter.reset();
}

/**
 * Bumped whenever the crossfilter changes, so cell-based panels can depend on
 * it and recompute.
 *
 * The panels that aggregate a few hundred rows (daily spend, attribution, the
 * session table) are cells rather than Mosaic clients — see DailySpend.tsx on
 * why. That leaves them outside the coordinator's push, so they need something
 * reactive to key on, and a version counter is the smallest thing that works.
 */
const filterVersion = appScope.durableSignal<number>("filterVersion", 0);

/**
 * The crossfilter's current predicate as SQL text, for those cell consumers.
 *
 * Read from the `Selection` itself rather than mirrored from `brushRange`, and
 * that distinction is load-bearing. Mirroring worked while the timeline was the
 * only thing that published a clause; the turn scatter is a second producer
 * with a second dimension (cost), and a mirror of one range would silently
 * ignore it. Asking the Selection means any number of producers compose, which
 * is what a crossfilter is for.
 *
 * `predicate(undefined)` is documented as "a predicate with all clauses" — no
 * client to exclude, which is right: a cell is nobody's source, so nothing
 * should be skipped on its behalf.
 */
export function filterSql(): string {
  const p = filter.predicate(undefined);
  const parts = (Array.isArray(p) ? p : [p])
    .filter((x) => x != null && x !== true)
    .map((x) => String(x))
    .filter((s) => s.length > 0);
  return parts.length ? parts.join(" AND ") : "TRUE";
}

/** True when anything is brushed — the panels say so rather than looking empty. */
export const filterActive = (): boolean => {
  filterVersion.get(); // subscribe: the predicate itself is not reactive
  return filterSql() !== "TRUE";
};

/** Idempotent: the first caller kicks the load, everyone else awaits it. */
export function ensureLoaded(): Promise<void> {
  engineBox.loading ??= load().catch((e: unknown) => {
    loadError.set(e instanceof Error ? e.message : String(e));
    throw e;
  });
  return engineBox.loading;
}

async function load(): Promise<void> {
  // Yield before the first write. Solid 2.0 rejects a reactive write inside an
  // owned scope, and whoever calls `ensureLoaded` — a component body, a cell's
  // compute — is inside one synchronously. After an await the owner is no
  // longer current, so every signal this function touches is written safely.
  await Promise.resolve();
  progress.set({ fraction: null, label: "starting DuckDB" });
  const db = await instantiateDuckDB(BUNDLES);
  const conn = await db.connect();
  // preagg OFF, deliberately and permanently. It is the one component in
  // mosaic-core that is coupled to a client's table: it materialises its view as
  // `Query.from(clientQuery._from).select({...activeClauseColumns})` — the
  // CLIENT's table with the CLAUSE's columns. A cross-table clause (our whole
  // crossfilter design: a session-grain brush reaching a `turns` client via a
  // semi-join) therefore makes it emit SQL naming a column that does not exist
  // in that table, and the client gets a hard `Binder Error`, not a slow path.
  //
  // A per-client `filterStable = false` also makes preagg decline, and where it
  // is TRUE it is the better fix — SessionTimelineClient says exactly that,
  // because its group keys really are the surviving sessions. But it is not a
  // general substitute: an aggregate that is *genuinely* stable under filtering
  // (the token-class and attribution panels, grouped by model / project / skill)
  // would have to misstate its own semantics purely to dodge the optimizer. The
  // breakage is not about stability at all, so the switch belongs here.
  const coordinator = new Coordinator(undefined, { preagg: { enabled: false } });
  coordinator.databaseConnector(wasmConnector({ duckdb: db, connection: conn }));
  engineBox.engine = { db, conn, coordinator };

  const registerTable = async (name: string, url: string, onBytes: (f: number) => void) => {
    const buf = await fetchWithProgress(url, onBytes);
    await db.registerFileBuffer(`${name}.parquet`, buf);
    await conn.query(
      `CREATE OR REPLACE TABLE "${name}" AS SELECT * FROM read_parquet('${name}.parquet')`,
    );
  };

  const names = Object.keys(TABLES) as Array<keyof typeof TABLES>;
  let done = 0;
  for (const name of names) {
    progress.set({ fraction: done / names.length, label: `loading ${name}` });
    await registerTable(name, TABLES[name], (within: number) => {
      progress.set({ fraction: (done + within) / names.length, label: `loading ${name}` });
    });
    done++;
  }

  // The optional grains, each independently. One that is absent (an older
  // src/data) or malformed must not take the other four down with it, so every
  // failure is recorded and swallowed rather than propagated.
  for (const name of Object.keys(OPTIONAL_TABLES) as Array<keyof typeof OPTIONAL_TABLES>) {
    progress.set({ fraction: 1, label: `loading ${name}` });
    try {
      await registerTable(name, OPTIONAL_TABLES[name], () => {});
      loaded.add(name);
    } catch {
      /* grain not in this dataset — the app runs without it */
    }
  }

  progress.set({ fraction: 1, label: "summarizing" });
  await loadManifest();
  summary.set(await querySummary(conn));

  // Connect the crossfilter clients only now: `prepare()` queries `turns`, so
  // the tables have to exist before the coordinator initialises them.
  const tl = new SessionTimelineClient({
    filterBy: filter,
    hasForkEdges: loaded.has("forkEdges"),
    onResult: (data) => {
      timeline.set(data);
      timelineBusy.set(false);
    },
    onDomain: (d) => timelineDomain.set(d),
    onPending: () => timelineBusy.set(true),
    onError: (e) => {
      timelineBusy.set(false);
      loadError.set(e.message);
    },
  });
  clientBox.timeline = tl;
  coordinator.connect(tl);
  coordinator.connect(new SelectionStatsClient(filter, (s) => selectionStats.set(s)));

  // The bridge from Mosaic's push to Solid's pull. Registered once, after the
  // clients, so the first event a panel sees is a real one.
  filter.addEventListener("value", () => {
    filterVersion.set(filterVersion.get() + 1);
  });

  ready.set(true);
  progress.set({ fraction: 1, label: "ready" });
}

/**
 * Fetched rather than imported: the manifest is written beside the parquet by
 * the normalizer, and a missing one should degrade to "unlabelled numbers", not
 * a build error in a fresh checkout.
 */
async function loadManifest(): Promise<void> {
  try {
    const res = await fetch(new URL("../data/manifest.json", import.meta.url));
    if (res.ok) manifest.set((await res.json()) as Manifest);
  } catch {
    /* no manifest — the UI falls back to "pricing table unknown" */
  }
}

async function querySummary(c: AsyncDuckDBConnection): Promise<CorpusSummary> {
  const rows = await c.query(`
    SELECT count(*)                    AS turns,
           count(DISTINCT sessionId)   AS sessions,
           -- project, not projectSlug. A slug is a cwd, so a worktree gets its
           -- own; collapsing them to the repository root is what projectLabel
           -- is for, and counting slugs here reported 18 projects for a corpus
           -- that has 12.
           count(DISTINCT project)     AS projects,
           min(epoch_ms(ts))           AS firstTs,
           max(epoch_ms(ts))           AS lastTs,
           sum(costTotal)              AS totalCost,
           sum(costInput)              AS costInput,
           sum(costOutput)             AS costOutput,
           sum(costCacheCreate)        AS costCacheCreate,
           sum(costCacheRead)          AS costCacheRead
    FROM turns
  `);
  const r = rows.get(0)?.toJSON() as Record<string, unknown> | undefined;
  const n = (k: string) => Number(r?.[k] ?? 0); // Number() handles the BigInt columns too
  return {
    turns: n("turns"),
    sessions: n("sessions"),
    projects: n("projects"),
    firstTs: n("firstTs"),
    lastTs: n("lastTs"),
    totalCost: n("totalCost"),
    costInput: n("costInput"),
    costOutput: n("costOutput"),
    costCacheCreate: n("costCacheCreate"),
    costCacheRead: n("costCacheRead"),
  };
}

/**
 * DuckDB hands back INT64 / HUGEINT columns as BigInt, which then poisons every
 * downstream arithmetic and every `new Date(...)` with "Cannot convert a BigInt
 * value to a number". Coercing once here — rather than at each call site — is
 * what keeps the cells and the chart specs free of the problem. Token counts and
 * epoch-millisecond timestamps are both far inside Number's exact-integer range,
 * so nothing is lost.
 */
function unwrapBigInts(row: Record<string, unknown>): Record<string, unknown> {
  for (const k in row) {
    const v = row[k];
    if (typeof v === "bigint") row[k] = Number(v);
  }
  return row;
}

/**
 * Sessions that have a replay file, resolved once from `replay/index.json`.
 *
 * An index rather than a 404 probe: "this session has no replay" and "the
 * dataset was built without `--replay`" are different answers and the UI says
 * different things about them.
 */
const replayIndex = appScope.durableSignal<ReadonlyMap<string, ReplayIndexEntry> | null>(
  "replayIndex",
  null,
);

export interface ReplayIndexEntry {
  sessionId: string;
  rows: number;
  bytes: number;
  t0: number;
  t1: number;
}

async function loadReplayIndex(): Promise<void> {
  try {
    const res = await fetch(new URL("../data/replay/index.json", import.meta.url));
    if (!res.ok) return;
    const list = (await res.json()) as ReplayIndexEntry[];
    replayIndex.set(new Map(list.map((e) => [e.sessionId, e])));
  } catch {
    /* dataset built without --replay; the panel says so */
  }
}

/** Which replay files are already registered, so a re-open costs nothing. */
const replayLoaded = appScope.durable<Set<string>>("replayLoaded", () => new Set<string>());

/**
 * Fetch and register one session's replay Parquet, then return its table name.
 *
 * The replay grain is 29.5 MB across 109 files and is deliberately NOT loaded
 * at startup — a replay is always scoped to one session, so it is fetched when
 * that session is opened and kept for the rest of the page's life.
 */
export async function ensureReplay(sessionId: string): Promise<string | null> {
  await ensureLoaded();
  if (replayIndex.get() === null) await loadReplayIndex();
  if (!replayIndex.get()?.has(sessionId)) return null;
  const table = `replay_${sessionId.replace(/-/g, "_")}`;
  if (replayLoaded.has(sessionId)) return table;
  const e = engineBox.engine;
  if (!e) throw new Error("no connection");
  const url = new URL(`../data/replay/${sessionId}.parquet`, import.meta.url);
  const buf = await fetchWithProgress(url.href, () => {});
  await e.db.registerFileBuffer(`${table}.parquet`, buf);
  await e.conn.query(
    `CREATE OR REPLACE TABLE "${table}" AS SELECT * FROM read_parquet('${table}.parquet')`,
  );
  replayLoaded.add(sessionId);
  return table;
}

/** Ad-hoc query against the loaded tables. Used by cells and by agent tools. */
export async function sql<T = Record<string, unknown>>(query: string): Promise<T[]> {
  await ensureLoaded();
  const e = engineBox.engine;
  if (!e) throw new Error("no connection");
  const result = await e.conn.query(query);
  return result.toArray().map((r) => unwrapBigInts(r.toJSON() as Record<string, unknown>) as T);
}

export const store = {
  progress: progress.get,
  ready: ready.get,
  loadError: loadError.get,
  manifest: manifest.get,
  summary: summary.get,
  filter,
  get coordinator(): Coordinator {
    const e = engineBox.engine;
    if (!e) throw new Error("coordinator not ready — await ensureLoaded()");
    return e.coordinator;
  },
  ensureLoaded,
  sql,
  // the session timeline's read side
  timeline: timeline.get,
  timelineDomain: timelineDomain.get,
  timelineBusy: timelineBusy.get,
  selectionStats: selectionStats.get,
  brushRange: brushRange.get,
  hasTable: (name: string): boolean => loaded.has(name),
  collapsedProjects: collapsedProjects.get,
  expandedSessions: expandedSessions.get,
  focusedSession: focusedSession.get,
  visibleProjects: visibleProjects.get,
  toggleProjectVisible,
  setVisibleProjects,
  clearAllFilters,
  replayIndex: replayIndex.get,
  filterVersion: filterVersion.get,
  filterSql,
  filterActive,
  ensureReplay,
};
