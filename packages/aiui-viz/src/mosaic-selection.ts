/**
 * mosaic-selection.ts — declared, agent-drivable cross-filter dimensions over
 * Mosaic Selections: the control-surface treatment for the one kind of app
 * state Mosaic keeps to itself.
 *
 * A Mosaic Selection is an undifferentiated bag of prebuilt SQL clauses.
 * Verified against the pinned `@uwdata/mosaic-core@0.28` source: clause
 * routing does not exist — the only clause a filtered client is ever spared
 * is its OWN (crossfilter self-exclusion by client object identity), so a
 * clause naming a column a client's table lacks becomes a DuckDB binder
 * error that Mosaic logs and swallows while the chart freezes on stale data.
 * Every mouse interactor publishes clauses keyed by a stable `source` object,
 * and publishing a clause from the same source REPLACES the prior one; a
 * clause whose `predicate` is null is the retraction idiom.
 *
 * A **selection dimension** reifies one logical filter (a magnitude range, an
 * event-type pick) the way `control()` reifies one parameter: declared once
 * in the store with a compiler-injected name and description, validated in
 * one place, durable across hot edits, visible in `report()`, and exposed to
 * agents as a real named tool (`set-<name>`, registered through `action()` so
 * the standard-tools pipeline, the page-tools relay, and the oracle all see
 * it with a real JSON Schema). Setting a dimension publishes clauses exactly
 * the way a mouse brush does — same Selection, same clause shape, stable
 * per-(dimension, target) sources — so every coordinated view cross-filters
 * identically for a drag, a `page_tools_call`, and a spoken sentence.
 *
 * Multi-table is first-class because Mosaic won't do it for us: a dimension
 * takes a LIST of targets, each pairing a Selection with a table-appropriate
 * field expression, and fans the semantic value out as one clause per target
 * ("time" can be `epoch_ms(ts)` on `turns` and `started_at` on `sessions`).
 * The `include` relay cannot substitute — it forwards the same clause object
 * verbatim. One coordinator, one table, one Selection stays the degenerate
 * common case: one target.
 *
 * Distilled from the two apps that hand-rolled all of this (seismos'
 * `set-filter` tool; cc-miner's filter/version-counter bridge), including the
 * paid-for findings their notes record:
 *
 *  - A geographic box is TWO dimensions (lon, lat): a hand-built 2-D
 *    `clauseIntervals` clause needs scale metadata to resolve in a
 *    crossfilter and silently fails to propagate; two 1-D clauses always do.
 *  - One-sided ranges (`{ lo: 5 }`) build `>=`/`<=` predicates directly —
 *    mosaic's own `clauseInterval` only knows BETWEEN, but the clause shape
 *    is public plain data.
 *  - The coordinator batches: a `report()` immediately after a set reads
 *    pre-update counts — await a task boundary before re-reading them.
 *  - Pre-aggregation binds a clause's raw columns against each client's own
 *    table; a deliberately cross-table dimension therefore needs preagg
 *    disabled (cc-miner's global switch) or `filterStable = false` clients.
 *  - The Selections a dimension targets must be DURABLE (store-owned), like
 *    every Mosaic root — the dimension's own value is; a disposable Selection
 *    would forget the clauses while the dimension remembers the range.
 *
 * Deliberately NOT here (yet): declaration-time column validation against the
 * live catalog (a cheap DESCRIBE turning tomorrow's silent binder error into
 * today's loud one — needs a coordinator handle, planned), named-view
 * serialization (a separate module; serialize dimension VALUES, never
 * clauses), and write-back into vgplot's own brush rectangles (an agent-set
 * dimension filters the data but draws no rectangle; d3-brush cannot be
 * driven by synthetic pointers — see NOTES.md finding 7 in demos/seismos).
 *
 * Lives on its own subpath (`@habemus-papadum/aiui-viz/mosaic-selection`) so
 * `@uwdata/mosaic-core` / `@uwdata/mosaic-sql` stay optional peers only
 * Mosaic consumers install — unlike `./mosaic` (structural on purpose), this
 * module genuinely constructs clauses, so it imports the real builders.
 */
import { clauseInterval, clausePoints } from "@uwdata/mosaic-core";
import type { ExprNode } from "@uwdata/mosaic-sql";
import { column, gte, lte } from "@uwdata/mosaic-sql";
import { createSignal } from "solid-js";
import { type ActionSpec, action } from "./control";
import { durable, durableSignal } from "./durable";
import type { Scope } from "./scope";
import { surfaceViewFor } from "./standard-tools";

// ---------------------------------------------------------------------------
// The structural Selection surface (a real mosaic Selection satisfies it; a
// test fake needs only this much).

/** The slice of a Selection clause this module reads or writes. */
export interface SelectionClauseLike {
  /** Stable identity — publishing from the same source REPLACES the clause. */
  source: object;
  /** Clients this clause must not filter (crossfilter self-exclusion). */
  clients?: unknown;
  /** The semantic value ([lo, hi], picked points, …); null when retracted. */
  value: unknown;
  /** The prebuilt SQL predicate; null IS the retraction. */
  predicate: unknown;
  meta?: unknown;
}

/**
 * The slice of a Mosaic `Selection` a dimension drives — structural, so tests
 * can fake it, but pass the real durable Selection your views coordinate on.
 */
export interface SelectionLike {
  update(clause: SelectionClauseLike): unknown;
  readonly clauses: readonly SelectionClauseLike[];
  /** Present on real Selections: the resolved WHERE for a client (undefined
   * client = all clauses). Used by {@link selectionPredicateSql}. */
  predicate?(client?: unknown, noSkip?: boolean): unknown;
  addEventListener(type: string, callback: (value: unknown) => void): void;
  removeEventListener(type: string, callback: (value: unknown) => void): void;
}

// ---------------------------------------------------------------------------
// Dimension declarations

/** One place a dimension publishes: a Selection plus the field it filters. */
export interface SelectionDimTarget {
  /** The Selection to publish into — a durable store root. */
  selection: SelectionLike;
  /** Column name (wrapped as a column ref) or a prebuilt mosaic-sql
   * expression (`sql`epoch_ms(ts)``) — per-target, which is what lets one
   * dimension speak each table's column vocabulary. */
  field: string | ExprNode;
  /** The table this target's filtered clients query. Documentation surfaced
   * in the surface snapshot and tool descriptions — Mosaic itself never
   * routes clauses by table (module docblock); the declaration is where that
   * knowledge lives. */
  table?: string;
}

/** An interval dimension's semantic value. One side alone = open-ended. */
export type IntervalValue = { lo?: number; hi?: number } | null;
/** A point dimension's semantic value: rows matching ANY value pass. */
export type PointValue = readonly (string | number | boolean)[] | null;

interface BaseDimSpec {
  /** Identity: durable key + tool name. Compiler-injected from the binding. */
  name?: string;
  /** Instance qualifier (see scope.ts) — effective identity `<scope>/<name>`. */
  scope?: Scope;
  /** Human description — compiler-lifted from the doc comment, or explicit. */
  description?: string;
  /** Definition site "file:line" — compiler-injected. */
  loc?: string;
  /** Where this dimension publishes (≥ 1; one per table vocabulary). */
  targets: readonly SelectionDimTarget[];
}

/** A numeric range filter (histogram-brush-shaped). */
export interface IntervalDimSpec extends BaseDimSpec {
  kind: "interval";
  /** Inclusive lower bound for WRITES (clamped, like a control's min). */
  min?: number;
  /** Inclusive upper bound for WRITES (clamped). */
  max?: number;
  /** Display unit ("km", "Hz") — presentation only. */
  unit?: string;
}

/** A categorical filter (menu/toggle-shaped). */
export interface PointDimSpec extends BaseDimSpec {
  kind: "point";
  /** Legal values (enums). A write outside the set THROWS. */
  options?: readonly (string | number | boolean)[];
}

export type SelectionDimSpec = IntervalDimSpec | PointDimSpec;

/** A live dimension: the semantic value box plus its identity and targets. */
export interface SelectionDim<V> {
  /** The effective identity — scope-qualified when declared with one. */
  readonly name: string;
  readonly kind: "interval" | "point";
  /** The declaring scope's name, when scoped. */
  readonly scope?: string;
  readonly description?: string;
  readonly loc?: string;
  readonly targets: readonly SelectionDimTarget[];
  /** Reactive read of the semantic value (null = no filter). */
  get(): V;
  /**
   * Validate, publish one clause per target (replacing this dimension's
   * prior clause — stable sources), and store the semantic value. Returns
   * what was APPLIED (clamped/normalized) — never a re-read; writes are
   * staged (see durable.ts).
   */
  set(value: V): V;
  /** Retract this dimension's clause from every target. */
  clear(): null;
}

/** A snapshot entry of the dimension surface (see {@link selectionDimSurface}). */
export interface SelectionDimSurfaceEntry {
  name: string;
  kind: "interval" | "point";
  scope?: string;
  description?: string;
  loc?: string;
  value: unknown;
  targets: { table?: string; field: string }[];
}

const dims = new Map<string, SelectionDim<unknown>>();

const MISSING_NAME =
  "selectionDim() needs a name — either the aiui() Vite plugin " +
  "(@habemus-papadum/aiui-source-processor, whose locator pass infers it from the assignment " +
  'binding) or an explicit { name: "…" }. The name is the durable key and the agent-tool ' +
  "identity; it cannot be anonymous.";

/** A target's field, printable ("quakes.mag", "epoch_ms(ts)"). */
function targetLabel(t: SelectionDimTarget): { table?: string; field: string } {
  const field = typeof t.field === "string" ? t.field : String(t.field);
  return { ...(t.table !== undefined ? { table: t.table } : {}), field };
}

function targetsPhrase(targets: readonly SelectionDimTarget[]): string {
  return targets
    .map((t) => {
      const l = targetLabel(t);
      return l.table !== undefined ? `${l.table}.${l.field}` : l.field;
    })
    .join(", ");
}

/**
 * Declare one cross-filter dimension. Returns the semantic-value box; also
 * registers a real `set-<name>` action (a named, schema'd agent tool via the
 * standard-tools pipeline) and enrolls the dimension in the surface snapshot.
 *
 * ```ts
 * /** Magnitude window — the completeness bracket every view filters by. *\/
 * export const mag = selectionDim({
 *   scope: appScope,
 *   kind: "interval",
 *   targets: [{ selection: brush, field: "mag", table: "quakes" }],
 *   min: 0, max: 10,
 * });
 * mag.set({ lo: 5 });        // one-sided: mag >= 5, every view updates
 * mag.set({ lo: 5, hi: 6 }); // replaces (stable source), never stacks
 * mag.clear();
 * ```
 */
export function selectionDim(spec: IntervalDimSpec): SelectionDim<IntervalValue>;
export function selectionDim(spec: PointDimSpec): SelectionDim<PointValue>;
export function selectionDim(spec: SelectionDimSpec): SelectionDim<IntervalValue | PointValue> {
  const leaf = spec.name;
  if (!leaf) throw new Error(MISSING_NAME);
  const name = spec.scope !== undefined ? spec.scope.qualify(leaf) : leaf;
  if (spec.targets.length === 0) {
    throw new Error(`selectionDim "${name}": needs at least one target`);
  }

  // Durable by construction, like a control: the semantic value survives hot
  // edits exactly as long as the (durable, store-owned) Selections holding
  // the published clauses do — the two stay consistent by living together.
  const box = durableSignal<IntervalValue | PointValue>(`dim:${name}`, null);

  // Stable per-target clause sources: a Selection replaces-by-source, so
  // these must survive module re-evaluation or an HMR'd set would STACK a
  // second clause beside the orphaned first. The reset hook keeps the
  // semantic value honest when something external calls selection.reset()
  // (mosaic invokes reset() on every removed clause's source).
  const sources = spec.targets.map((_, i) =>
    durable(`dim:${name}:src:${i}`, () => ({
      name: `dim:${name}:${i}`,
      reset: () => {
        box.set(null);
      },
    })),
  );

  const fieldExpr = (f: string | ExprNode) => (typeof f === "string" ? column(f) : f);

  const publishInterval = (value: IntervalValue): void => {
    spec.targets.forEach((t, i) => {
      const field = fieldExpr(t.field);
      const source = sources[i];
      let clause: SelectionClauseLike;
      if (value === null) {
        clause = clauseInterval(field, null, { source }); // predicate null = retraction
      } else if (value.lo !== undefined && value.hi !== undefined) {
        clause = clauseInterval(field, [value.lo, value.hi], { source });
      } else {
        // One-sided: clauseInterval only builds BETWEEN; the clause shape is
        // public plain data, so build it with the matching comparison. The
        // interval meta carries no scales, which makes preagg decline it —
        // exactly the safe behavior for a programmatic clause.
        clause = {
          meta: { type: "interval" },
          source,
          value: [value.lo ?? null, value.hi ?? null],
          predicate: value.lo !== undefined ? gte(field, value.lo) : lte(field, value.hi as number),
        };
      }
      t.selection.update(clause);
    });
  };

  const publishPoint = (value: PointValue): void => {
    spec.targets.forEach((t, i) => {
      t.selection.update(
        clausePoints([fieldExpr(t.field)], value === null ? null : value.map((v) => [v]), {
          source: sources[i],
        }),
      );
    });
  };

  const validateInterval = (s: IntervalDimSpec, next: IntervalValue): IntervalValue => {
    if (next === null || next === undefined) return null;
    const side = (which: "lo" | "hi", raw: number | undefined): number | undefined => {
      if (raw === undefined || raw === null) return undefined;
      if (typeof raw !== "number" || !Number.isFinite(raw)) {
        throw new Error(
          `selectionDim "${name}": ${which} must be a finite number, got ${JSON.stringify(raw)}`,
        );
      }
      let n = raw;
      if (s.min !== undefined) n = Math.max(s.min, n);
      if (s.max !== undefined) n = Math.min(s.max, n);
      return n;
    };
    const lo = side("lo", next.lo);
    const hi = side("hi", next.hi);
    if (lo === undefined && hi === undefined) return null; // {} clears
    if (lo !== undefined && hi !== undefined && lo > hi) {
      throw new Error(`selectionDim "${name}": lo (${lo}) must be ≤ hi (${hi})`);
    }
    return { ...(lo !== undefined ? { lo } : {}), ...(hi !== undefined ? { hi } : {}) };
  };

  const validatePoint = (s: PointDimSpec, next: PointValue): PointValue => {
    if (next === null || next === undefined) return null;
    if (!Array.isArray(next)) {
      throw new Error(
        `selectionDim "${name}": expected an array of values, got ${JSON.stringify(next)}`,
      );
    }
    if (next.length === 0) return null; // "select none of them" = no filter (mosaic's own reading)
    for (const v of next) {
      const t = typeof v;
      if (t !== "string" && t !== "number" && t !== "boolean") {
        throw new Error(`selectionDim "${name}": values must be primitives, got ${t}`);
      }
      if (s.options !== undefined && !s.options.includes(v)) {
        const legal = s.options.map((o) => JSON.stringify(o)).join(", ");
        throw new Error(
          `selectionDim "${name}": value ${JSON.stringify(v)} is not one of ${legal}`,
        );
      }
    }
    return [...next];
  };

  const set = (next: IntervalValue | PointValue): IntervalValue | PointValue => {
    const applied =
      spec.kind === "interval"
        ? validateInterval(spec, next as IntervalValue)
        : validatePoint(spec, next as PointValue);
    box.set(applied);
    if (spec.kind === "interval") publishInterval(applied as IntervalValue);
    else publishPoint(applied as PointValue);
    return applied;
  };

  const dim: SelectionDim<IntervalValue | PointValue> = {
    name,
    kind: spec.kind,
    ...(spec.scope !== undefined ? { scope: spec.scope.name } : {}),
    ...(spec.description !== undefined ? { description: spec.description } : {}),
    ...(spec.loc !== undefined ? { loc: spec.loc } : {}),
    targets: spec.targets,
    get: () => box.get(),
    set,
    clear: () => {
      set(null);
      return null;
    },
  };

  // Same collision semantics as control(): same loc (or unknowable) is the
  // HMR shape; a different definition site is two declarations fighting.
  const existing = dims.get(name);
  if (existing?.loc !== undefined && spec.loc !== undefined && existing.loc !== spec.loc) {
    console.warn(
      `aiui: selectionDim "${name}" re-registered from ${spec.loc} (was ${existing.loc}) — ` +
        "two declarations share a name; the later one wins.",
    );
  }
  dims.set(name, dim);
  registerDimAction(spec, dim, leaf);
  return dim;
}

/** The derived verb: one `set-<name>` action per dimension, so the standard
 * tools, the page-tools relay, and the oracle all get a real, schema'd tool
 * with zero app wiring. The spec is built as a VARIABLE and passed to
 * `action()` — never an inline options object: this module is compiled by the
 * consuming app's aiui plugin (workspace source-first), and an inline literal
 * with a computed `name` is a compile error there by design. The prebuilt-
 * object form is the sanctioned dynamic-registration path (the runtime name
 * guard is the backstop). */
function registerDimAction(
  spec: SelectionDimSpec,
  dim: SelectionDim<IntervalValue | PointValue>,
  leaf: string,
): void {
  const where = targetsPhrase(spec.targets);
  const prefix = spec.description !== undefined ? `${spec.description} — ` : "";
  const clearProp = { clear: { type: "boolean", description: "true removes this filter" } };
  let actionSpec: ActionSpec;
  if (spec.kind === "interval") {
    const unit = spec.unit !== undefined ? ` (${spec.unit})` : "";
    const bounds = {
      ...(spec.min !== undefined ? { minimum: spec.min } : {}),
      ...(spec.max !== undefined ? { maximum: spec.max } : {}),
    };
    actionSpec = {
      name: `set-${leaf}`,
      ...(spec.scope !== undefined ? { scope: spec.scope } : {}),
      ...(spec.loc !== undefined ? { loc: spec.loc } : {}),
      description:
        `${prefix}Set the "${leaf}" cross-filter, an interval on ${where}${unit}: pass lo ` +
        "and/or hi (one side alone gives an open-ended range); { clear: true } removes the " +
        "filter. Every coordinated view updates. Returns { applied } — trust it over the " +
        "request (bounds clamp). Counts refresh after a task boundary; re-read report() then.",
      inputSchema: {
        type: "object",
        properties: {
          lo: { type: "number", description: "inclusive lower bound", ...bounds },
          hi: { type: "number", description: "inclusive upper bound", ...bounds },
          ...clearProp,
        },
        additionalProperties: false,
      },
      run: (args = {}) => {
        if (args.clear === true) return { name: dim.name, applied: dim.clear() };
        const lo = args.lo as number | undefined;
        const hi = args.hi as number | undefined;
        if (lo == null && hi == null) {
          throw new Error(`set-${leaf}: pass lo and/or hi (numbers), or { clear: true }`);
        }
        return {
          name: dim.name,
          applied: dim.set({
            ...(lo != null ? { lo } : {}),
            ...(hi != null ? { hi } : {}),
          }),
        };
      },
    };
  } else {
    const pointSpec = spec;
    actionSpec = {
      name: `set-${leaf}`,
      ...(spec.scope !== undefined ? { scope: spec.scope } : {}),
      ...(spec.loc !== undefined ? { loc: spec.loc } : {}),
      description:
        `${prefix}Set the "${leaf}" cross-filter, a categorical pick on ${where}: pass values ` +
        "(rows matching ANY of them pass); { clear: true } removes the filter. Every " +
        "coordinated view updates. Returns { applied }. Counts refresh after a task boundary; " +
        "re-read report() then.",
      inputSchema: {
        type: "object",
        properties: {
          values: {
            type: "array",
            description: "values to select — rows matching any of them pass",
            items: pointSpec.options !== undefined ? { enum: [...pointSpec.options] } : {},
          },
          ...clearProp,
        },
        additionalProperties: false,
      },
      run: (args = {}) => {
        if (args.clear === true) return { name: dim.name, applied: dim.clear() };
        const values = args.values as PointValue | undefined;
        if (values == null) {
          throw new Error(`set-${leaf}: pass values (an array), or { clear: true }`);
        }
        return { name: dim.name, applied: dim.set(values) };
      },
    };
  }
  action(actionSpec);
}

/** Look up a live dimension by (qualified) name. */
export function selectionDimByName(name: string): SelectionDim<unknown> | undefined {
  return dims.get(name);
}

/**
 * Snapshot of the dimension surface — every declared dimension with its
 * current semantic value and printable targets. With a scope, the shared
 * membership rule applies ({@link surfaceViewFor}: the scope's subtree plus
 * unscoped declarations) — the same view the standard tools and the oracle
 * projection serve.
 */
export function selectionDimSurface(scope?: Scope | string): SelectionDimSurfaceEntry[] {
  const scopeName = typeof scope === "string" ? scope : scope?.name;
  const view = scopeName !== undefined ? surfaceViewFor(scopeName) : undefined;
  const out: SelectionDimSurfaceEntry[] = [];
  for (const d of dims.values()) {
    if (view !== undefined && !view.owns(d.name)) continue;
    out.push({
      name: d.name,
      kind: d.kind,
      ...(d.scope !== undefined ? { scope: d.scope } : {}),
      ...(d.description !== undefined ? { description: d.description } : {}),
      ...(d.loc !== undefined ? { loc: d.loc } : {}),
      value: d.get(),
      targets: d.targets.map(targetLabel),
    });
  }
  return out;
}

/**
 * The report section: `{ <dimension>: <semantic value> }`, nulls included —
 * an inactive dimension still tells the agent the filter EXISTS. Wire it as
 * `kit.registerReporter("filters", () => selectionDimReport(appScope))`.
 */
export function selectionDimReport(scope?: Scope | string): Record<string, unknown> {
  return Object.fromEntries(selectionDimSurface(scope).map((e) => [e.name, e.value]));
}

/** Clear every dimension (of a scope's view, or all): the "reset filters"
 * verb, one retraction per (dimension, target). */
export function clearAllSelectionDims(scope?: Scope | string): void {
  for (const e of selectionDimSurface(scope)) {
    dims.get(e.name)?.clear();
  }
}

/**
 * @internal Hard clear for library-internal tests that declare fresh
 * dimensions per case (the control.test.ts pattern) — returns the durable
 * keys to dispose. App tests should clear VALUES via clearAllSelectionDims.
 */
export function clearSelectionDimRegistry(): { durableKeys: string[] } {
  const durableKeys: string[] = [];
  for (const d of dims.values()) {
    durableKeys.push(`dim:${d.name}`);
    for (let i = 0; i < d.targets.length; i++) {
      durableKeys.push(`dim:${d.name}:src:${i}`);
    }
  }
  dims.clear();
  return { durableKeys };
}

// ---------------------------------------------------------------------------
// Selection → signal (the generic read-back bridge)

/** A reactive window onto one Selection (see {@link selectionSignal}). */
export interface SelectionSignal {
  /** Bumps on every Selection value event — the reactive key. */
  version: () => number;
  /** Reactive snapshot of the live clauses (mouse, agent, and dim alike). */
  clauses: () => readonly SelectionClauseLike[];
  /** Reactive: is anything filtering? */
  active: () => boolean;
  /** Reactive: the full predicate as SQL text, `"TRUE"` when unfiltered —
   * for cell deps that push the filter into their own queries. */
  sql: () => string;
  dispose: () => void;
}

/**
 * Bridge one Selection into Solid: a version counter bumped by the
 * Selection's own `value` event, with derived reactive views over the clause
 * list. This is the read side that makes "reset filters (N)" labels and
 * filter-aware cells track EVERY producer — a mouse brush, a menu, another
 * agent — not just this module's dimensions (mirroring one writer is the bug;
 * the Selection is the meeting point). Extracted from cc-miner's
 * filterVersion/filterSql pattern.
 *
 * Create it once per Selection in the store:
 * `appScope.durable("brushSignal", () => selectionSignal(brush))`.
 */
export function selectionSignal(sel: SelectionLike): SelectionSignal {
  const [version, setVersion] = createSignal(0);
  // Updater form on purpose: two clauses landing in one tick must compose
  // through Solid's staged writes (control.ts records the measured failure).
  const bump = () => setVersion((v) => v + 1);
  sel.addEventListener("value", bump);
  return {
    version,
    clauses: () => {
      version();
      return sel.clauses;
    },
    active: () => {
      version();
      return sel.clauses.some((c) => c.predicate != null);
    },
    sql: () => {
      version();
      return selectionPredicateSql(sel);
    },
    dispose: () => sel.removeEventListener("value", bump),
  };
}

/**
 * One Selection's whole predicate as SQL text — `"TRUE"` when nothing
 * filters. `predicate(undefined)` means "all clauses, exclude nobody"; the
 * clause-list fallback covers structural fakes. Interpolate into hand-rolled
 * cell queries as `WHERE ${selectionPredicateSql(sel)}`.
 */
export function selectionPredicateSql(sel: SelectionLike): string {
  const resolved =
    sel.predicate !== undefined ? sel.predicate(undefined) : sel.clauses.map((c) => c.predicate);
  const list = resolved == null ? [] : Array.isArray(resolved) ? resolved : [resolved];
  const parts = list
    .filter((p) => p != null && p !== true)
    .map(String)
    .filter((s) => s.length > 0 && s !== "TRUE");
  return parts.length > 0 ? parts.join(" AND ") : "TRUE";
}
