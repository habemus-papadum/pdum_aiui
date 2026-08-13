/**
 * mosaic-facet.ts — component adoption: the binding layer that makes a
 * declared dimension and an on-screen Mosaic component ONE thing.
 *
 * The model (decided 2026-08-13, "components-first"): crossfilter semantics
 * are component-relative — a clause's `source` identity is what replace-by-
 * source keys on, its `clients` set is what crossfilter self-exclusion reads,
 * and the component's visual is the only honest indicator of its own state.
 * So instead of a dimension publishing its own clause NEXT TO the component's
 * (two clauses on one column, AND'd — the measured empty-intersection trap),
 * a binding ADOPTS the live component and routes the dimension's writes
 * through the component's own publish path:
 *
 *  - a voice/agent `set` publishes a clause whose source IS the interactor,
 *    with the interactor's own clients set, and moves the brush rectangle
 *    (moveSilent post-init; the `value` seed pre-render — Interval1D.init
 *    redraws from `this.value`, mosaic's never-public restore path);
 *  - a mouse drag is simply the component publishing natively — the binding
 *    mirrors the value back into the dimension's durable box (quietly: no
 *    republish, so no feedback loop is possible);
 *  - one clause per bound dimension, always, from one source.
 *
 * Adoption is dynamic because components are ephemeral: MosaicView re-creates
 * every interactor on rebuild (theme flip, HMR) and none exist pre-render.
 * The binding watches the producer registry (mosaic-registry.ts): while its
 * producer is live it drives the component; when the producer disappears it
 * falls back to the dimension's own HEADLESS clause (so a filter survives a
 * rebuild gap), and hands back on re-adoption — headless publish on release,
 * component publish + headless retraction on adopt. A dimension that never
 * binds keeps today's headless behavior untouched; that degenerate case is
 * the right shape for multi-table fan-out and chart-less columns (a filter
 * with no view of its own has nothing to self-exclude).
 *
 * Transforms bridge value spaces: the dimension stores SEMANTIC units (years,
 * degrees) — what the agent speaks and named views serialize — while `to`/
 * `from` convert to the component's data space (epoch dates on a time brush;
 * an Equal-Earth box on a projected map, where a PAIR of dimensions adopts
 * one 2-D interactor jointly).
 *
 * Ordering rules this module is built around (verified in mosaic 0.28 src):
 * interactor `g`/`scale` handles exist only post-init and are REBUILT every
 * render — resolve at call time, never cache; a scale-less 1-D interval
 * clause is fine (it is exactly the headless dim shape) but a 2-D clause
 * needs live scales to resolve in a crossfilter, so 2-D adoption defers its
 * publish (bounded retry) until the scales exist; registry callbacks can fire
 * inside an owned Solid scope, so adoption reads NO signals — the binding
 * keeps a plain shadow of each dimension's last value instead.
 */
import { clauseInterval, clauseIntervals, clausePoint, clausePoints } from "@uwdata/mosaic-core";
import type { ExprNode } from "@uwdata/mosaic-sql";
import { column, gte, lte } from "@uwdata/mosaic-sql";
import type { MosaicProducerEntry } from "./mosaic-registry";
import { mosaicProducerByName, onMosaicProducersChange } from "./mosaic-registry";
import type { IntervalValue, PointValue, SelectionDim, SelectionLike } from "./mosaic-selection";

// ---------------------------------------------------------------------------
// Binding specs

/** Bind one interval dimension to a 1-D interval component (histogram brush,
 * ramp legend). `to` maps the semantic value into the component's data space
 * (default: `[lo ?? null, hi ?? null]`); `from` maps a component value back. */
export interface IntervalFacetBinding {
  dim: SelectionDim<IntervalValue>;
  /** Registry name of the producer to adopt (e.g. "seismos/mag-hist"). */
  producer: string;
  to?: (v: IntervalValue) => readonly (number | Date | null)[] | null;
  from?: (cv: unknown) => IntervalValue;
}

/** Bind TWO interval dimensions jointly to one 2-D interactor (a map box).
 * Transforms are required — the joint mapping is never the identity. `to`
 * must return a full `[[x0,x1],[y0,y1]]` box or null (a 2-D brush cannot be
 * one-sided); `from` returns the pair of semantic values in `dims` order. */
export interface PairFacetBinding {
  dims: readonly [SelectionDim<IntervalValue>, SelectionDim<IntervalValue>];
  producer: string;
  to: (a: IntervalValue, b: IntervalValue) => readonly (readonly number[])[] | null;
  from: (cv: unknown) => readonly [IntervalValue, IntervalValue];
}

/** Bind one point dimension to a categorical component (toggle bar, menu).
 * Defaults: `to` wraps values as tuples (`[[v], …]`), `from` unwraps. */
export interface PointFacetBinding {
  dim: SelectionDim<PointValue>;
  producer: string;
  to?: (v: PointValue) => readonly (readonly unknown[])[] | null;
  from?: (cv: unknown) => PointValue;
}

export type FacetBinding = IntervalFacetBinding | PairFacetBinding | PointFacetBinding;

// ---------------------------------------------------------------------------
// Internal shapes (duck-typed against mosaic-plot / mosaic-inputs 0.28)

/** @internal The seam selectionDim() installs for this module. */
interface DimInternals {
  __publishHeadless(v: unknown): void;
  __setPublishOverride(fn: ((applied: unknown) => void) | undefined): void;
  __setBoxQuiet(v: unknown): void;
}

interface InteractorLike {
  value?: unknown;
  g?: { call: (fn: unknown, ...args: unknown[]) => unknown };
  brush?: { moveSilent: unknown };
  scale?: ScaleLike;
  xscale?: ScaleLike;
  yscale?: ScaleLike;
  pixelSize?: number;
  field?: unknown;
  xfield?: unknown;
  yfield?: unknown;
  fields?: unknown[];
  mark?: { plot?: { markSet?: unknown } };
  selectedValue?: (v: unknown) => void;
}
interface ScaleLike {
  apply: (v: unknown) => number;
}

function internals(dim: SelectionDim<unknown>): DimInternals {
  const d = dim as unknown as Partial<DimInternals>;
  if (typeof d.__setPublishOverride !== "function") {
    throw new Error(`facet binding: "${dim.name}" is not a selectionDim (no override seam)`);
  }
  return d as DimInternals;
}

function fieldExpr(f: unknown): ExprNode {
  return typeof f === "string" ? column(f) : (f as ExprNode);
}

/** The clients set the component's own publish would carry: the whole plot's
 * mark set for an interactor, the input itself for a widget. */
function clientsOf(source: object): unknown {
  const s = source as InteractorLike;
  return s.mark?.plot?.markSet ?? new Set([source]);
}

function valueEq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  return JSON.stringify(a) === JSON.stringify(b);
}

// ---------------------------------------------------------------------------
// The binder

interface BindingState {
  producer: string;
  kind: "interval" | "pair" | "point";
  dims: SelectionDim<unknown>[];
  selection: SelectionLike;
  to: (...semantic: unknown[]) => unknown;
  from: (cv: unknown) => unknown;
  entry: MosaicProducerEntry | undefined;
  /** Plain mirror of each dim's last value — adoption paths must not read
   * Solid signals (registry callbacks can fire inside owned scopes). */
  shadow: unknown[];
  /** Last component-space value THIS binding published (loop guard). */
  lastDriven: unknown;
  hadClause: boolean;
  /** 2-D publish deferred until the interactor's scales exist. */
  retry?: ReturnType<typeof setTimeout>;
  retriesLeft: number;
  onValue: (v: unknown) => void;
}

const defaultIntervalTo = (v: unknown): unknown => {
  const iv = v as IntervalValue;
  return iv == null ? null : [iv.lo ?? null, iv.hi ?? null];
};
const defaultIntervalFrom = (cv: unknown): IntervalValue => {
  if (cv == null || !Array.isArray(cv)) return null;
  const [a, b] = cv;
  const num = (x: unknown): number | undefined => (typeof x === "number" ? x : undefined);
  const lo = num(a);
  const hi = num(b);
  if (lo === undefined && hi === undefined) return null;
  return { ...(lo !== undefined ? { lo } : {}), ...(hi !== undefined ? { hi } : {}) };
};
const defaultPointTo = (v: unknown): unknown => {
  const pv = v as PointValue;
  return pv == null || pv.length === 0 ? null : pv.map((x) => [x]);
};
const defaultPointFrom = (cv: unknown): PointValue => {
  if (cv == null) return null;
  // A menu's native clausePoint carries a SCALAR value; toggles and
  // multi-point clauses carry tuple arrays.
  if (!Array.isArray(cv)) return [cv] as never;
  if (cv.length === 0) return null;
  return cv.map((t) => (Array.isArray(t) ? t[0] : t)) as never;
};

/**
 * Install the bindings and start watching the producer registry. Call once
 * from the durable store, after the dims are declared:
 *
 * ```ts
 * bindSelectionComponents({ bindings: [
 *   { dim: mag, producer: "seismos/mag-hist" },
 *   { dim: year, producer: "seismos/time-hist", to: yearsToDates, from: datesToYears },
 *   { dims: [lon, lat], producer: "seismos/map", to: degreesToEqBox, from: eqBoxToDegrees },
 * ]});
 * ```
 *
 * Returns `{ dispose }`; a durable store never needs to call it.
 */
export function bindSelectionComponents(opts: { bindings: readonly FacetBinding[] }): {
  dispose: () => void;
} {
  const states: BindingState[] = opts.bindings.map((b) => {
    const pair = "dims" in b;
    const dims: SelectionDim<unknown>[] = pair
      ? [...(b as PairFacetBinding).dims]
      : [(b as IntervalFacetBinding | PointFacetBinding).dim as SelectionDim<unknown>];
    for (const d of dims) {
      if (d.targets.length !== 1) {
        throw new Error(
          `facet binding "${b.producer}": dim "${d.name}" has ${d.targets.length} targets — ` +
            "component adoption needs exactly one (multi-table dims stay headless)",
        );
      }
    }
    const selection = dims[0].targets[0].selection;
    if (dims.length === 2 && dims[1].targets[0].selection !== selection) {
      throw new Error(`facet binding "${b.producer}": paired dims target different Selections`);
    }
    const kind = pair ? "pair" : (dims[0].kind as "interval" | "point");
    const to = pair
      ? ((b as PairFacetBinding).to as (...s: unknown[]) => unknown)
      : kind === "interval"
        ? (((b as IntervalFacetBinding).to as ((v: unknown) => unknown) | undefined) ??
          defaultIntervalTo)
        : (((b as PointFacetBinding).to as ((v: unknown) => unknown) | undefined) ??
          defaultPointTo);
    const from = pair
      ? ((b as PairFacetBinding).from as (cv: unknown) => unknown)
      : kind === "interval"
        ? (((b as IntervalFacetBinding).from as ((cv: unknown) => unknown) | undefined) ??
          defaultIntervalFrom)
        : (((b as PointFacetBinding).from as ((cv: unknown) => unknown) | undefined) ??
          defaultPointFrom);
    const state: BindingState = {
      producer: b.producer,
      kind,
      dims,
      selection,
      to,
      from,
      entry: undefined,
      shadow: dims.map((d) => d.get()),
      lastDriven: null,
      hadClause: false,
      retriesLeft: 0,
      onValue: () => onSelectionValue(state),
    };
    return state;
  });

  // Writes route through the binding: drive the adopted component, or fall
  // through to the dim's own headless clause — byte-identical to unbound.
  for (const state of states) {
    state.dims.forEach((dim, i) => {
      internals(dim).__setPublishOverride((applied) => {
        state.shadow[i] = applied;
        if (state.entry !== undefined) drive(state);
        else internals(dim).__publishHeadless(applied);
      });
    });
    state.selection.addEventListener("value", state.onValue);
  }

  const resolveAll = (): void => {
    for (const state of states) {
      const entry = mosaicProducerByName(state.producer);
      if (entry?.source === state.entry?.source) continue;
      if (entry === undefined) release(state);
      else adopt(state, entry);
    }
  };
  const unsubscribe = onMosaicProducersChange(resolveAll);
  resolveAll();

  return {
    dispose: () => {
      unsubscribe();
      for (const state of states) {
        for (const dim of state.dims) internals(dim).__setPublishOverride(undefined);
        state.selection.removeEventListener("value", state.onValue);
        if (state.retry !== undefined) clearTimeout(state.retry);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Adoption lifecycle

function semanticIsNull(state: BindingState): boolean {
  return state.shadow.every((v) => v == null);
}

function adopt(state: BindingState, entry: MosaicProducerEntry): void {
  state.entry = entry;
  state.hadClause = false;
  state.lastDriven = null;
  if (semanticIsNull(state)) return;
  // The filter exists: publish it through the component (visual included),
  // then retract the headless clause it rode on. 2-D may defer on scales —
  // the headless clause stays until the component clause actually lands.
  drive(state);
}

function release(state: BindingState): void {
  if (state.entry === undefined) return;
  state.entry = undefined;
  state.hadClause = false;
  state.lastDriven = null;
  if (state.retry !== undefined) {
    clearTimeout(state.retry);
    state.retry = undefined;
  }
  // The component (and its clause, via MosaicView's ghost-clause retraction)
  // is gone; keep the FILTER alive headlessly until something re-adopts.
  if (!semanticIsNull(state)) {
    state.dims.forEach((dim, i) => {
      internals(dim).__publishHeadless(state.shadow[i]);
    });
  }
}

/** Mirror direction: the component published (a drag, a menu pick) or its
 * clause vanished (reset, single-resolution displacement). */
function onSelectionValue(state: BindingState): void {
  const entry = state.entry;
  if (entry === undefined) return;
  const clause = state.selection.clauses.find((c) => c.source === entry.source);
  if (clause !== undefined) {
    state.hadClause = true;
    if (valueEq(clause.value, state.lastDriven)) {
      // Our own publish echoing back. A menu's late update() (its options
      // query landing after our drive) re-syncs from valueFor and can reset
      // the <select> while this emit was still queued — re-assert it.
      confirmPointVisual(state);
      return;
    }
    state.lastDriven = clause.value;
    applySemantic(state, state.from(clause.value));
  } else if (state.hadClause) {
    state.hadClause = false;
    state.lastDriven = null;
    applySemantic(state, null);
  }
}

/** Idempotent re-assert of a menu's select (no-op for anything else). */
function confirmPointVisual(state: BindingState): void {
  if (state.kind !== "point") return;
  const src = state.entry?.source as InteractorLike | undefined;
  if (src === undefined || typeof src.selectedValue !== "function") return;
  const v = state.lastDriven;
  const scalar = Array.isArray(v) ? (v.length > 0 ? (v[0] as unknown[])[0] : "") : (v ?? "");
  src.selectedValue(scalar);
}

function applySemantic(state: BindingState, semantic: unknown): void {
  if (state.kind === "pair") {
    const [a, b] = (semantic ?? [null, null]) as [unknown, unknown];
    state.shadow[0] = a;
    state.shadow[1] = b;
    internals(state.dims[0]).__setBoxQuiet(a);
    internals(state.dims[1]).__setBoxQuiet(b);
  } else {
    state.shadow[0] = semantic;
    internals(state.dims[0]).__setBoxQuiet(semantic);
  }
}

// ---------------------------------------------------------------------------
// Driving the component (voice/agent → visual + clause)

function drive(state: BindingState): void {
  const entry = state.entry;
  if (entry === undefined) return;
  const cv =
    state.kind === "pair" ? state.to(state.shadow[0], state.shadow[1]) : state.to(state.shadow[0]);
  if (state.kind === "pair") drivePair(state, entry, cv);
  else if (state.kind === "interval") driveInterval(state, entry, cv);
  else drivePoint(state, entry, cv);
}

function retractHeadless(state: BindingState): void {
  for (const dim of state.dims) internals(dim).__publishHeadless(null);
}

function publishComponentClause(state: BindingState, clause: object): void {
  state.selection.update(clause as never);
  retractHeadless(state);
}

function driveInterval(state: BindingState, entry: MosaicProducerEntry, cv: unknown): void {
  const iv = entry.source as InteractorLike;
  const range = cv as readonly (number | Date | null)[] | null;
  state.lastDriven = range;
  state.hadClause = range != null;

  const lo = range?.[0] ?? null;
  const hi = range?.[1] ?? null;
  const field = fieldExpr(iv.field ?? entry.fields[0]);
  const source = entry.source;
  const clients = clientsOf(source);

  // Visual: both-sided ranges seed `value` (init redraws from it) and move
  // the live brush; one-sided ranges clamp to nothing — no honest rectangle
  // exists — so the brush clears while the clause still filters.
  const bothSided = lo !== null && hi !== null;
  iv.value = bothSided ? [lo, hi] : undefined;
  if (iv.g !== undefined && iv.brush !== undefined) {
    if (bothSided && iv.scale !== undefined) {
      const px = [iv.scale.apply(lo), iv.scale.apply(hi)].sort((a, b) => a - b);
      iv.g.call(iv.brush.moveSilent, px);
    } else {
      iv.g.call(iv.brush.moveSilent, null);
    }
  }

  let clause: object;
  if (range == null || (lo === null && hi === null)) {
    clause = { meta: { type: "interval" }, source, clients, value: null, predicate: null };
  } else if (bothSided) {
    clause = clauseInterval(field, [lo, hi] as never, { source, clients: clients as never });
  } else {
    // One-sided: the same hand-built shape the headless dims use.
    clause = {
      meta: { type: "interval" },
      source,
      clients,
      value: [lo, hi],
      predicate: lo !== null ? gte(field, lo) : lte(field, hi as never),
    };
  }
  publishComponentClause(state, clause);
}

function drivePair(state: BindingState, entry: MosaicProducerEntry, cv: unknown): void {
  const iv = entry.source as InteractorLike;
  const box = cv as readonly (readonly number[])[] | null;
  state.lastDriven = box;
  state.hadClause = box != null;
  iv.value = box ?? undefined;

  const source = entry.source;
  const clients = clientsOf(source);
  if (box == null) {
    if (iv.g !== undefined && iv.brush !== undefined) iv.g.call(iv.brush.moveSilent, null);
    publishComponentClause(state, {
      meta: { type: "interval" },
      source,
      clients,
      value: null,
      predicate: null,
    });
    return;
  }

  const xs = iv.xscale;
  const ys = iv.yscale;
  if (xs === undefined || ys === undefined) {
    // Pre-render: `value` is seeded (init will draw the box); a scale-less
    // 2-D clause does not resolve in a crossfilter, so retry until the
    // scales exist. The headless clause keeps filtering meanwhile.
    scheduleRetry(state);
    return;
  }
  const [xr, yr] = box;
  const px = [xs.apply(xr[0]), xs.apply(xr[1])].sort((a, b) => a - b);
  const py = [ys.apply(yr[0]), ys.apply(yr[1])].sort((a, b) => a - b);
  if (iv.g !== undefined && iv.brush !== undefined) {
    iv.g.call(iv.brush.moveSilent, [
      [px[0], py[0]],
      [px[1], py[1]],
    ]);
  }
  const fx = fieldExpr(iv.xfield ?? entry.fields[0]);
  const fy = fieldExpr(iv.yfield ?? entry.fields[1]);
  publishComponentClause(
    state,
    clauseIntervals([fx, fy], box as never, {
      source,
      clients: clients as never,
      scales: [xs, ys] as never,
      pixelSize: iv.pixelSize ?? 1,
    }),
  );
}

function scheduleRetry(state: BindingState): void {
  if (state.retry !== undefined) return;
  state.retriesLeft = 60;
  const tick = (): void => {
    state.retry = undefined;
    const entry = state.entry;
    if (entry === undefined || semanticIsNull(state)) return;
    const iv = entry.source as InteractorLike;
    if (iv.xscale !== undefined && iv.yscale !== undefined) {
      drive(state);
      return;
    }
    state.retriesLeft -= 1;
    if (state.retriesLeft > 0) state.retry = setTimeout(tick, 50);
  };
  state.retry = setTimeout(tick, 50);
}

function drivePoint(state: BindingState, entry: MosaicProducerEntry, cv: unknown): void {
  const src = entry.source as InteractorLike;
  const tuples = cv as readonly (readonly unknown[])[] | null;
  state.hadClause = tuples != null;

  // Visuals: a Toggle reads its own `value` (tuples) as prior state and the
  // Highlight companion re-styles from the selection; a Menu moves its
  // <select> through selectedValue (one value — the closest a menu can show;
  // the inspector carries the full truth).
  if (typeof src.selectedValue === "function") {
    src.selectedValue(tuples == null || tuples.length === 0 ? "" : tuples[0][0]);
  } else if ("value" in src) {
    src.value = tuples ?? null;
  }

  const fields =
    Array.isArray(src.fields) && src.fields.length > 0
      ? src.fields.map(fieldExpr)
      : src.field != null
        ? [fieldExpr(src.field)]
        : entry.fields.map(fieldExpr);
  const menuLike = typeof src.selectedValue === "function";
  const scalar = menuLike && (tuples == null || tuples.length <= 1);
  // lastDriven must hold the CLAUSE's value shape (a scalar for a menu's
  // native clausePoint), or the mirror listener would mistake our own
  // publish for a mouse pick and round-trip it through `from`.
  state.lastDriven = scalar ? (tuples == null ? null : tuples[0][0]) : tuples;
  const clause = scalar
    ? // A menu's native clause is a SCALAR clausePoint — matching it keeps
      // the menu's own valueFor-based re-sync coherent.
      clausePoint(fields[0] as never, (tuples == null ? undefined : tuples[0][0]) as never, {
        source: entry.source,
        clients: clientsOf(entry.source) as never,
      })
    : clausePoints(fields as never, (tuples ?? undefined) as never, {
        source: entry.source,
        clients: clientsOf(entry.source) as never,
      });
  publishComponentClause(state, clause);
}
