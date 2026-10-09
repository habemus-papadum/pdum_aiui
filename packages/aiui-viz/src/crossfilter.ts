/**
 * crossfilter.ts — the cross-filter an aiui app coordinates on, with clause
 * ROUTING: a clause reaches a client only when the client's table can bind
 * every column the clause names. Mosaic itself routes nothing (the module
 * doc of ./mosaic-selection records the measured consequence: a clause on a
 * column some client's table lacks is a DuckDB binder error Mosaic logs and
 * swallows while that chart freezes on stale data). The one per-client
 * decision Mosaic does make is `SelectionResolver.skip(client, clause)` —
 * cross-filter self-exclusion — and a `Selection` takes its resolver in the
 * constructor, so this module supplies a resolver whose `skip` adds one
 * rule: skip when the clause's columns are not all present in the client's
 * table. That `skip` is consulted everywhere a clause meets a client in
 * mosaic-core 0.28 (verified in its source): the predicate built for each
 * client update, the client's first query on connect, and the
 * pre-aggregator, which asks `selection.skip` before materializing and
 * derives its non-active filter from `remove(source)` — a clone that keeps
 * the resolver. A client whose table lacks the active clause's column is
 * therefore skipped rather than re-queried, which is right: its effective
 * filter did not change.
 *
 * The rules this encodes, and their edges:
 *
 *  - **Same column name means the same thing.** A clause on `year` filters
 *    every table with a `year` column. Where two tables share a name by
 *    accident, `exclude` names the columns a table must not take.
 *  - **A missing column drops the clause for that table**, whole: a 2-D map
 *    box names two columns, and a table with only one of them gets neither.
 *  - **Columns come from the schema**, not from guessing: pass them up front
 *    (`columns`), feed them later (`learnColumns`, which the schema-view
 *    provider does from the DuckDB layer's introspection), or let `describe`
 *    fetch them when a table is first met. Until a table's columns are
 *    known the resolver routes everything to it — today's behaviour.
 *  - **A retraction carries a null predicate**, so the resolver remembers
 *    each source's last column set and routes the retraction the same way.
 *  - **Clients name their table** the way mosaic-plot marks (`sourceTable()`)
 *    and mosaic-inputs widgets (`from`) do; a client that names none gets
 *    every clause, as before.
 *
 * What falls out: one cross-filter per app, every view of every table
 * filters by it, and a dimension declares one target with a plain column
 * name. The multi-target fan-out in ./mosaic-selection stays for a renamed
 * or computed column, publishing into this same Selection. The resolver
 * also knows which tables it has routed to, and `crossfilterPredicateSql`
 * gives one table's resolved WHERE — the body of the `crossfilter.<table>`
 * schema views the DuckDB tool layer materializes.
 *
 * mosaic-core exports `SelectionResolver` as a type only, so the routing
 * resolver is built over a stock cross-filter resolver by prototype, with
 * `skip` and `predicate` overridden (`resolve` and `queueFilter` come
 * through unchanged). Both must be: the stock `predicate` returns NO filter
 * at all when `skip(client, active)` says the active clause is the client's
 * own — right for the brushing chart, wrong for a client whose table merely
 * lacks the active column, which would then query unfiltered on connect. So
 * the early return stays on self-exclusion alone and routing applies clause
 * by clause; the routed `skip` still serves the pre-aggregator, which asks
 * it before materializing and skips a client the active clause cannot reach.
 */
import type { MosaicClient, SelectionClause, SelectionResolver } from "@uwdata/mosaic-core";
import { Selection } from "@uwdata/mosaic-core";
import { collectColumns, literal, or } from "@uwdata/mosaic-sql";
import type { AgentToolkit } from "./agent-tools";
import { action } from "./control";
import type { SchemaViewProvider } from "./duckdb";
import { clientTable } from "./mosaic-registry";
import {
  clearAllSelectionDims,
  clearSelectionFor,
  onSelectionDimsChange,
  resetSelectionDimTargets,
  type SelectionDimSurfaceEntry,
  type SelectionLike,
  type SelectionSignal,
  selectionDimByName,
  selectionDimReport,
  selectionDimSurface,
  selectionDimTargets,
  selectionPredicateSql,
} from "./mosaic-selection";
import type { Scope } from "./scope";
import {
  type InspectorCapabilityRow,
  type InspectorClauseRow,
  selectionInspectorModel,
} from "./selection-inspector";

export { clientTable } from "./mosaic-registry";

export interface CrossfilterOptions {
  /** Selections whose clauses relay into this one (Mosaic's `include`). */
  include?: Selection[];
  /** Mosaic's `empty`: no clauses means no rows (default false: no filter). */
  empty?: boolean;
  /** Known columns per table, up front. */
  columns?: Record<string, readonly string[]>;
  /** Fetch a table's columns when it is first met (`DESCRIBE`); permissive until it answers. */
  describe?: (table: string) => Promise<readonly string[]>;
  /** Columns a table must NOT take even though it has them (same name, different meaning). */
  exclude?: Record<string, readonly string[]>;
}

/** The routing state behind a cross-filter (see the module doc). */
export interface CrossfilterRouting {
  /** Teach the router a table's columns (replaces what it knew). */
  learn(table: string, columns: readonly string[]): void;
  /** The columns the router knows for a table, if any. */
  columnsOf(table: string): readonly string[] | undefined;
  /** Every table the router has learned or routed to, sorted. */
  tables(): string[];
  /** Only the tables a client has actually asked a predicate for, sorted —
   * what the cross-filter demonstrably filters. */
  routedTables(): string[];
  /** The columns a clause names (its predicate's, or the last seen for its source). */
  clauseColumns(clause: SelectionClause): readonly string[] | undefined;
  /** Does this clause apply to this table? Permissive when either side is unknown. */
  routes(clause: SelectionClause, table: string): boolean;
}

const ROUTING = Symbol.for("aiui.crossfilter.routing");

/** The Selection-with-routing this module hands out: a plain Selection to every consumer, plus the router. */
type RoutedSelection = Selection & { [ROUTING]?: CrossfilterRouting };

function makeRouting(
  base: SelectionResolver,
  options: CrossfilterOptions,
): { resolver: SelectionResolver; routing: CrossfilterRouting } {
  const known = new Map<string, Set<string>>();
  const exclude = new Map<string, Set<string>>();
  const seen = new Set<string>();
  const bySource = new WeakMap<object, readonly string[]>();
  const pending = new Set<string>();

  for (const [table, cols] of Object.entries(options.columns ?? {}))
    known.set(table, new Set(cols));
  for (const [table, cols] of Object.entries(options.exclude ?? {}))
    exclude.set(table, new Set(cols));

  const clauseColumns = (clause: SelectionClause): readonly string[] | undefined => {
    const predicate = (clause as { predicate?: unknown }).predicate;
    if (predicate !== null && predicate !== undefined && typeof predicate === "object") {
      let cols: readonly string[];
      try {
        cols = collectColumns(predicate as never).map((c) => String(c.column));
      } catch {
        return undefined; // not a mosaic-sql tree: route everywhere
      }
      if (clause.source !== undefined && clause.source !== null) bySource.set(clause.source, cols);
      return cols;
    }
    return clause.source !== undefined && clause.source !== null
      ? bySource.get(clause.source)
      : undefined;
  };

  const request = (table: string): void => {
    if (options.describe === undefined || known.has(table) || pending.has(table)) return;
    pending.add(table);
    options.describe(table).then(
      (cols) => {
        pending.delete(table);
        routing.learn(table, cols);
      },
      () => {
        pending.delete(table); // let a later client retry
      },
    );
  };

  const routing: CrossfilterRouting = {
    learn(table, columns) {
      known.set(table, new Set(columns));
      warnMismatchedDims(table, columns);
    },
    columnsOf: (table) => {
      const cols = known.get(table);
      return cols === undefined ? undefined : [...cols];
    },
    tables: () => [...new Set([...known.keys(), ...seen])].sort(),
    routedTables: () => [...seen].sort(),
    clauseColumns,
    routes(clause, table) {
      const cols = clauseColumns(clause);
      if (cols === undefined) return true;
      const have = known.get(table);
      if (have === undefined) {
        request(table);
        return true;
      }
      const banned = exclude.get(table);
      return cols.every((c) => have.has(c) && !(banned?.has(c) ?? false));
    },
  };

  /** Record the client's table as one the cross-filter reaches (clauses or not). */
  const meet = (client: MosaicClient | null | undefined): string | undefined => {
    if (client === null || client === undefined) return undefined;
    const table = clientTable(client);
    if (table !== undefined) seen.add(table);
    return table;
  };

  const routedSkip = (
    client: MosaicClient | null | undefined,
    clause: SelectionClause,
  ): boolean => {
    if (base.skip(client, clause)) return true; // self-exclusion, as Mosaic does it
    const table = meet(client);
    if (table === undefined) return false;
    if (clause === null || clause === undefined) return false;
    return !routing.routes(clause, table);
  };

  // The stock cross-filter resolver with `skip` and `predicate` overridden
  // (see the module doc); `resolve` and `queueFilter` come through the
  // prototype. `predicate` is the stock body with routing in the per-clause
  // filter and the early return kept on self-exclusion alone.
  const resolver = Object.create(base) as SelectionResolver;
  resolver.skip = routedSkip;
  resolver.predicate = (clauseList, active, client) => {
    if (base.empty && clauseList.length === 0) return [literal(false)];
    if (base.skip(client, active)) return undefined;
    meet(client); // a client with no clause to route is still a table the cross-filter covers
    const predicates = clauseList
      .filter((clause) => !routedSkip(client, clause))
      .map((clause) => clause.predicate as NonNullable<SelectionClause["predicate"]>);
    return base.union && predicates.length > 1 ? or(...predicates) : predicates;
  };
  return { resolver, routing };
}

/** A declared dimension whose column is not in its declared table is a frozen chart waiting to happen: say so. */
function warnMismatchedDims(table: string, columns: readonly string[]): void {
  const have = new Set(columns);
  for (const dim of selectionDimTargets()) {
    for (const t of dim.targets) {
      if (t.table !== table) continue;
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(t.field) && !have.has(t.field)) {
        console.warn(
          `aiui: selectionDim "${dim.name}" filters ${table}.${t.field}, but ${table} has no ` +
            `column "${t.field}" (columns: ${columns.join(", ")}). Its clause will not route there.`,
        );
      }
    }
  }
}

/**
 * The cross-filter Selection every view of the app filters by — Mosaic's
 * `Selection.crossfilter()` with clause routing (see the module doc). Pass
 * it wherever a Selection goes; `crossfilterRouting(sel)` reaches the router.
 */
export function crossfilter(options: CrossfilterOptions = {}): Selection {
  const stock = Selection.crossfilter({ empty: options.empty === true });
  const { resolver, routing } = makeRouting(stock.resolver, options);
  const sel = new Selection(resolver, options.include ?? []) as RoutedSelection;
  sel[ROUTING] = routing;
  return sel;
}

/** The router behind a Selection made by {@link crossfilter}; undefined for a stock Selection. */
export function crossfilterRouting(sel: object): CrossfilterRouting | undefined {
  return (sel as RoutedSelection)[ROUTING];
}

/** Teach a cross-filter the columns of a table (no-op on a stock Selection). */
export function learnColumns(sel: object, table: string, columns: readonly string[]): void {
  crossfilterRouting(sel)?.learn(table, columns);
}

/** The clause-list shape this module reads (a real Selection, or a structural fake in tests). */
interface ClausesLike {
  clauses: readonly SelectionClause[];
}

/**
 * One table's resolved WHERE as SQL text — the clauses that route to it,
 * AND'd; `"TRUE"` when none do. On a stock Selection every clause routes.
 * The body of the `crossfilter.<table>` schema view.
 */
export function crossfilterPredicateSql(sel: ClausesLike, table: string): string {
  const routing = crossfilterRouting(sel);
  const parts = sel.clauses
    .filter((c) => c.predicate !== null && c.predicate !== undefined)
    .filter((c) => routing === undefined || routing.routes(c, table))
    .map((c) => String(c.predicate))
    .filter((s) => s.length > 0 && s !== "TRUE");
  return parts.length > 0 ? parts.join(" AND ") : "TRUE";
}

/** Which of a Selection's live clauses route to a table, and which do not (by their predicate text). */
export function crossfilterClausesFor(
  sel: ClausesLike,
  table: string,
): { applies: string[]; dropped: string[] } {
  const routing = crossfilterRouting(sel);
  const applies: string[] = [];
  const dropped: string[] = [];
  for (const c of sel.clauses) {
    if (c.predicate === null || c.predicate === undefined) continue;
    (routing === undefined || routing.routes(c, table) ? applies : dropped).push(
      String(c.predicate),
    );
  }
  return { applies, dropped };
}

// ── the schema-view provider ─────────────────────────────────────────────────

/** The tables a cross-filter covers: those it has routed to, the dimensions' declared targets, and any named. */
function coveredTables(
  sel: object,
  scope: Scope | string | undefined,
  extra: readonly string[] | undefined,
): string[] {
  const out = new Set<string>(crossfilterRouting(sel)?.routedTables() ?? []);
  for (const dim of selectionDimTargets(scope)) {
    for (const t of dim.targets) if (t.table !== undefined) out.add(t.table);
  }
  for (const t of extra ?? []) out.add(t);
  return [...out].sort();
}

const quoteIdent = (name: string): string => `"${name.replace(/"/g, '""')}"`;

/**
 * A base table named for a view body: every part quoted, the schema
 * ALWAYS present (`"main"."quakes"`). Inside a view that lives in another
 * schema and carries the table's name, a bare `"quakes"` binds to the view
 * itself — DuckDB reports infinite recursion (found live, 2026-10-09).
 */
export function baseTableRef(table: { name: string; schema?: string }): string {
  const parts = table.name.split(".");
  if (parts.length === 1)
    parts.unshift(table.schema !== undefined && table.schema !== "" ? table.schema : "main");
  return parts.map(quoteIdent).join(".");
}

export interface CrossfilterViewsOptions {
  /** The app's cross-filter (from {@link crossfilter}, or a stock Selection — then nothing routes). */
  selection: ClausesLike & {
    addEventListener?: (type: string, fn: () => void) => void;
    removeEventListener?: (type: string, fn: () => void) => void;
  };
  /** The app's scope: whose dimensions count as this cross-filter's. */
  scope?: Scope | string;
  /** Tables to offer a view for beyond those the router met and the dimensions declare. */
  tables?: readonly string[];
  /** The views' schema name (default `crossfilter`). */
  schema?: string;
}

/**
 * The cross-filter as a schema-view provider for the DuckDB tools
 * (`registerSqlTools(kit, { views: [crossfilterViews({ selection, scope })] })`):
 * one `crossfilter.<table>` view per table the cross-filter covers — the
 * table under its routed WHERE — with provenance saying what filters it,
 * what does not reach it, and that the `cross-filter` tool changes it. It
 * also hands the base tables' columns to the router, so routing is exact
 * from the first `sql`/`schema` call on. The DuckDB layer knows nothing of
 * Mosaic; this is the whole bridge, and it points one way.
 */
export function crossfilterViews(options: CrossfilterViewsOptions): SchemaViewProvider {
  const schema = options.schema ?? "crossfilter";
  const sel = options.selection;
  return {
    id: "cross-filter",
    views(tables) {
      const routing = crossfilterRouting(sel);
      if (routing !== undefined) {
        for (const t of tables) {
          const cols = t.columns.map((c) => c.name);
          const had = routing.columnsOf(t.name);
          if (had === undefined || had.join("\n") !== cols.join("\n")) routing.learn(t.name, cols);
        }
      }
      const covered = new Set(coveredTables(sel, options.scope, options.tables));
      return tables
        .filter((t) => covered.has(t.name))
        .map((t) => ({
          schema,
          name: t.name,
          of: t.name,
          sql: () =>
            `SELECT * FROM ${baseTableRef(t)} WHERE ${crossfilterPredicateSql(sel, t.name)}`,
          describe: () => {
            const { applies, dropped } = crossfilterClausesFor(sel, t.name);
            return {
              provider: "cross-filter",
              predicate: crossfilterPredicateSql(sel, t.name),
              clauses: applies.length,
              ...(dropped.length > 0 ? { notApplied: dropped } : {}),
              changedBy:
                "the cross-filter and reset-cross-filters tools, or a brush or menu on the page",
            };
          },
        }));
    },
    subscribe(onChange) {
      sel.addEventListener?.("value", onChange);
      return () => sel.removeEventListener?.("value", onChange);
    },
    wants: () => coveredTables(sel, options.scope, options.tables),
  };
}

// ── the tools ────────────────────────────────────────────────────────────────

/** The JSON Schema for one dimension's value inside `cross-filter { set }`. */
export function selectionDimSchema(entry: SelectionDimSurfaceEntry): Record<string, unknown> {
  const about = entry.description ?? entry.name;
  if (entry.kind === "interval") {
    const unit = entry.unit !== undefined ? ` (${entry.unit})` : "";
    const bounds = {
      ...(entry.min !== undefined ? { minimum: entry.min } : {}),
      ...(entry.max !== undefined ? { maximum: entry.max } : {}),
    };
    return {
      type: "object",
      description: `${about}${unit} — lo and/or hi, inclusive; one side alone is open-ended`,
      properties: {
        lo: { type: "number", description: "inclusive lower bound", ...bounds },
        hi: { type: "number", description: "inclusive upper bound", ...bounds },
      },
      additionalProperties: false,
    };
  }
  return {
    type: "array",
    description: `${about} — rows matching ANY of the values pass`,
    items: entry.options !== undefined ? { enum: [...entry.options] } : {},
  };
}

/** A dimension's name relative to its scope (`seismos/mag` → `mag`). */
function leafOf(entry: { name: string; scope?: string }): string {
  return entry.scope !== undefined && entry.name.startsWith(`${entry.scope}/`)
    ? entry.name.slice(entry.scope.length + 1)
    : entry.name;
}

/** How long a tool result waits for the Selection's first emit after a write. */
const SETTLE_MS = 400;
/** …and for each further emit once one arrived. */
const SETTLE_MORE_MS = 150;
/** …never longer than this in all. */
const SETTLE_MAX_MS = 1500;

/** Resolve true on the Selection's next `value` emit, false at the timeout. */
function nextEmit(sel: SelectionLike, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const on = (): void => {
      clearTimeout(timer);
      sel.removeEventListener("value", on);
      resolve(true);
    };
    const timer = setTimeout(() => {
      sel.removeEventListener("value", on);
      resolve(false);
    }, timeoutMs);
    sel.addEventListener("value", on);
  });
}

export interface CrossfilterToolsOptions {
  /** The app's scope: the tools register under it and serve its dimensions. */
  scope: Scope;
  /** The app's cross-filter — the predicate the tools report. */
  selection: ClausesLike & SelectionLike;
  /** Extra tables the report should name beyond the covered ones. */
  tables?: readonly string[];
  /** The schema the views live in (default `crossfilter`), for the report's `views`. */
  schema?: string;
  /** App-specific work after a reset — which always clears every dimension,
   * resets every target Selection (brushes and menus included) and resets
   * the cross-filter itself. */
  onReset?: () => void;
  /**
   * How long a write's result waits for the first emit before reporting the
   * predicate (default 400 ms, an in-tab DuckDB's query batch); the later
   * windows scale with it. A remote engine wants its round trip — a few
   * seconds — or the result reports the clause the page is still replacing.
   */
  settleMs?: number;
}

/** The `crossfilter` report section. */
export interface CrossfilterReport {
  /** The aggregate WHERE over every live clause (`TRUE` when unfiltered). */
  predicate: string;
  /** Each covered table's routed WHERE. */
  tables: Record<string, string>;
  /** The schema views that carry those (query them with `sql`). */
  views: string[];
  /** Every declared dimension and its value (null = declared, inactive). */
  dimensions: Record<string, unknown>;
  /** The live clauses, attributed to a dimension or an on-screen component. */
  active: InspectorClauseRow[];
  /** What could filter here, grouped by column set. */
  capabilities: InspectorCapabilityRow[];
}

/** The report, computed on demand (non-reactive: `report()` is a snapshot). */
export function crossfilterReport(options: CrossfilterToolsOptions): CrossfilterReport {
  const sel = options.selection;
  const signal: SelectionSignal = {
    version: () => 0,
    clauses: () => sel.clauses,
    active: () => sel.clauses.some((c) => c.predicate !== null && c.predicate !== undefined),
    sql: () => selectionPredicateSql(sel),
    dispose: () => {},
  };
  const model = selectionInspectorModel({ signal, scope: options.scope });
  const schema = options.schema ?? "crossfilter";
  const covered = coveredTables(sel, options.scope, options.tables);
  return {
    predicate: selectionPredicateSql(sel),
    tables: Object.fromEntries(covered.map((t) => [t, crossfilterPredicateSql(sel, t)])),
    views: covered.map((t) => `${schema}.${t}`),
    dimensions: selectionDimReport(options.scope),
    active: model.clauses,
    capabilities: model.capabilities,
  };
}

/**
 * Register the cross-filter's agent surface on a kit, for one scope:
 *
 *  - `cross-filter { set?: { <dim>: value }, clear?: [names] }` — ONE tool
 *    for every declared dimension, the way `set` is one tool for every
 *    control: its schema carries a typed property per dimension (bounds,
 *    enums, the doc comment), re-rendered whenever a dimension is declared;
 *    several dimensions in one call is one atomic write; `clear` names
 *    dimensions or on-screen components. Returns what was applied, what was
 *    cleared, any per-name error, and the predicate now in force.
 *  - `reset-cross-filters` — every clause gone, every visual reset.
 *  - the `crossfilter` report section ({@link crossfilterReport}).
 *
 * Returns the unsubscribe for the dimension watcher.
 */
export function registerCrossfilterTools(
  kit: AgentToolkit,
  options: CrossfilterToolsOptions,
): () => void {
  const { scope, selection } = options;
  const schema = options.schema ?? "crossfilter";
  // A Selection's clause list is its EMITTED state, and Mosaic emits after the
  // coordinator's query batch — hundreds of milliseconds on a large table —
  // one source per emit. So a result that reports the predicate now in force
  // waits for the emits to quiesce (bounded): the first within SETTLE_MS, each
  // further one within SETTLE_MORE_MS, SETTLE_MAX_MS in all. report() after a
  // task boundary remains the final word, as the usage says.
  const scale = (options.settleMs ?? SETTLE_MS) / SETTLE_MS;
  const settled = async (): Promise<void> => {
    const start = Date.now();
    let timeout = SETTLE_MS * scale;
    for (;;) {
      const emitted = await nextEmit(selection, timeout);
      if (!emitted || Date.now() - start > SETTLE_MAX_MS * scale) break;
      timeout = SETTLE_MORE_MS * scale;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  const predicateNow = (): Record<string, unknown> => {
    const covered = coveredTables(selection, scope, options.tables);
    return {
      predicate: selectionPredicateSql(selection),
      ...(covered.length > 0 ? { views: covered.map((t) => `${schema}.${t}`) } : {}),
    };
  };

  const registerSet = (): void => {
    const entries = selectionDimSurface(scope);
    const properties: Record<string, unknown> = {};
    const lines: string[] = [];
    for (const e of entries) {
      const leaf = leafOf(e);
      properties[leaf] = selectionDimSchema(e);
      const shape =
        e.kind === "interval"
          ? `interval${e.min !== undefined || e.max !== undefined ? ` ${e.min ?? "…"}–${e.max ?? "…"}` : ""}${e.unit !== undefined ? ` ${e.unit}` : ""}`
          : e.options !== undefined
            ? `one or more of ${e.options.map((o) => JSON.stringify(o)).join(", ")}`
            : "values";
      lines.push(`${leaf} (${shape}${e.usage !== undefined ? `; ${e.usage}` : ""})`);
    }
    action({
      scope,
      name: "cross-filter",
      kind: "write",
      group: "crossfilter",
      description:
        "Set or clear the page's cross-filter dimensions — the filters every coordinated view " +
        "shares with the brushes and menus on screen. set takes one entry per dimension (an " +
        "interval {lo, hi} or an array of values; each replaces that dimension's own clause); " +
        "clear takes dimension or component names. Returns { applied, cleared, errors?, " +
        "predicate, views }.",
      usage:
        `Dimensions: ${lines.join("; ") || "(none declared yet)"}. Set several in one call — ` +
        "it is one write. Trust applied over the request (bounds clamp, values are checked). " +
        "The predicate is the WHERE now in force; query the filtered rows with sql on the " +
        "views it names (crossfilter.<table>). Counts on the page refresh after a task " +
        "boundary; re-read report then. Clearing a component (report's " +
        "crossfilter.capabilities names them) clears its whole brush.",
      inputSchema: {
        type: "object",
        properties: {
          set: {
            type: "object",
            description: "dimension → value; null clears that dimension",
            properties,
            additionalProperties: false,
          },
          clear: {
            type: "array",
            description: "dimensions or components to clear, by name",
            items: { type: "string" },
          },
        },
        additionalProperties: false,
      },
      run: async (args = {}) => {
        const applied: Record<string, unknown> = {};
        const cleared: string[] = [];
        const errors: Record<string, string> = {};
        const set = args.set;
        if (set !== undefined && (set === null || typeof set !== "object" || Array.isArray(set))) {
          throw new Error("cross-filter: set must be an object of dimension → value");
        }
        for (const [leaf, value] of Object.entries((set ?? {}) as Record<string, unknown>)) {
          const dim = selectionDimByName(scope.qualify(leaf)) ?? selectionDimByName(leaf);
          if (dim === undefined) {
            errors[leaf] = `no dimension "${leaf}" — dimensions: ${selectionDimTargets(scope)
              .map(leafOf)
              .join(", ")}`;
            continue;
          }
          try {
            applied[leaf] = value === null ? dim.clear() : dim.set(value as never);
          } catch (err) {
            errors[leaf] = err instanceof Error ? err.message : String(err);
          }
        }
        const clearList = args.clear;
        if (clearList !== undefined && !Array.isArray(clearList)) {
          throw new Error("cross-filter: clear must be an array of names");
        }
        for (const name of (clearList ?? []) as unknown[]) {
          try {
            cleared.push(clearSelectionFor(String(name), scope).cleared);
          } catch (err) {
            errors[String(name)] = err instanceof Error ? err.message : String(err);
          }
        }
        if (
          Object.keys(applied).length === 0 &&
          cleared.length === 0 &&
          Object.keys(errors).length === 0
        ) {
          throw new Error("cross-filter: pass set (dimension → value) and/or clear (names)");
        }
        await settled();
        return {
          applied,
          cleared,
          ...(Object.keys(errors).length > 0 ? { errors } : {}),
          ...predicateNow(),
        };
      },
    });
  };

  action({
    scope,
    name: "reset-cross-filters",
    kind: "write",
    group: "crossfilter",
    description:
      "Remove EVERY cross-filter clause — dimensions, map and histogram brushes, menus — and " +
      "reset their visuals, so every view shows the whole dataset. Returns { reset, " +
      "activeClauses, predicate }.",
    usage:
      'Call it for "reset", "clear everything", "show all". To clear one filter, use ' +
      "cross-filter { clear: [name] } instead.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: async () => {
      clearAllSelectionDims(scope);
      resetSelectionDimTargets(scope);
      // The cross-filter itself, too: with no dimension declared (columns
      // picked at run time, say) it is nobody's target, and its brushes
      // would stay. Selection.reset is idempotent.
      (selection as { reset?: () => void }).reset?.();
      options.onReset?.();
      // A reset clears the clause list at once and may emit nothing after:
      // wait for the page only while something is still to be retracted.
      if (selection.clauses.length > 0) await settled();
      else await new Promise((resolve) => setTimeout(resolve, 0));
      return { reset: true, activeClauses: selection.clauses.length, ...predicateNow() };
    },
  });

  kit.registerReporter("crossfilter", () => crossfilterReport(options));
  registerSet();
  return onSelectionDimsChange(registerSet);
}
