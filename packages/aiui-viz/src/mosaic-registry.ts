/**
 * mosaic-registry.ts — the live directory of Mosaic clause PRODUCERS: which
 * on-screen components (plot interactors, input widgets) can publish into
 * which Selection, over which columns, and what value each currently holds.
 *
 * Mosaic keeps none of this: a Selection only lists the clauses currently
 * constraining it (a retracted source vanishes entirely), a clause's `meta`
 * never names a column, and the only route from a clause back to "the brush
 * on the magnitude histogram" is the `source` object itself — the interactor
 * instance. So enumeration must come from the PLOT side, and someone has to
 * hold the plot handles: this module. `MosaicView` registers each Plot it
 * builds (its `scope`/`name` props); hand-constructed inputs (a mosaic-inputs
 * Menu) register through {@link registerMosaicInput}.
 *
 * Why it exists (the fluidity contract): the agent surface must be able to
 * answer "what can filter here, and through which component?" — when exactly
 * one component speaks "magnitude", a spoken filter needs no component name;
 * when several could, the agent should see the ambiguity and ask. The
 * capability grouping consumed by `selection-inspector` (and, later, facet
 * adoption) is derived from these entries.
 *
 * Structural on purpose: no `@uwdata/*` imports — entries hold the live
 * instances and read them by duck-typing (the property names are pinned by
 * mosaic-plot 0.28: `field`/`channel` on Interval1D, `xfield`/`yfield` on
 * Interval2D, `fields`+`as` on Toggle, `fields`+`brush` on Region,
 * `fields`+`maxRadius` on Nearest; PanZoom publishes domains, not filters,
 * and Highlight only consumes — both are skipped). Registrations are
 * REPLACED by name (a re-rendered MosaicView re-registers the same name) and
 * unregistration carries the "still mine?" guard, so a disposed view never
 * evicts its successor (the adopt.ts rule).
 */
import { createSignal } from "solid-js";
import { durable } from "./durable";
import type { Scope } from "./scope";
import { surfaceViewFor } from "./standard-tools";

/** The clause language a producer speaks. */
export type MosaicProducerKind = "interval" | "point" | "match" | "unknown";

/** One live clause-publishing component. */
export interface MosaicProducerEntry {
  /** Qualified name ("seismos/map", "seismos/mag-hist:legend"). */
  name: string;
  /** The registering scope's name, when scoped. */
  scope?: string;
  /** Where it lives: a plot's interactor, or a standalone input widget. */
  host: "plot" | "input";
  kind: MosaicProducerKind;
  /** Column names it filters (best-effort; expressions stringified). */
  fields: string[];
  /** The live instance — clause `source` identity for everything it publishes. */
  source: object;
  /** The Selection it publishes into. */
  selection: object;
  /** Current data-space value: the published clause value when one is live
   * (`selection.valueFor(source)`), else the instance's own `value` field.
   * The fallback can be stale for interactors retracted from outside without
   * `source.reset()` — one more reason clearing goes through `reset()`. */
  value(): unknown;
}

/** The slice of a Plot the registry walks (mosaic-plot's, structurally). */
export interface MosaicPlotLike {
  interactors: readonly object[];
  legends?: readonly { legend?: { handler?: object } }[];
}

interface Registration {
  token: object;
  entries: MosaicProducerEntry[];
}

interface RegistryBox {
  regs: Map<string, Registration>;
  version: () => number;
  bump: () => void;
}

/** Lazy so importing the barrel never touches `window` (durable needs it). */
function registry(): RegistryBox {
  return durable("mosaic-producers:registry", () => {
    // ownedWrite: registration happens inside MosaicView's effect handler (an
    // owned scope) — this is internal bookkeeping, the sanctioned exception.
    const [version, setVersion] = createSignal(0, { ownedWrite: true });
    return {
      regs: new Map<string, Registration>(),
      version,
      bump: () => setVersion((v) => v + 1),
    };
  });
}

function scopeName(scope: Scope | string | undefined): string | undefined {
  return typeof scope === "string" ? scope : scope?.name;
}

function qualify(scope: Scope | string | undefined, leaf: string): string {
  const s = scopeName(scope);
  return s !== undefined ? `${s}/${leaf}` : leaf;
}

/** A column name from a mosaic-sql node, a string, or anything else. */
function fieldName(f: unknown): string {
  if (typeof f === "string") return f;
  if (f !== null && typeof f === "object") {
    const col = (f as { column?: unknown }).column;
    if (typeof col === "string") return col;
  }
  return String(f);
}

interface InteractorShape {
  selection?: object;
  field?: unknown;
  channel?: unknown;
  xfield?: unknown;
  yfield?: unknown;
  fields?: unknown;
  as?: unknown;
  brush?: unknown;
  maxRadius?: unknown;
  value?: unknown;
}

/**
 * Classify one interactor instance: kind + the columns it filters. Returns
 * undefined for non-publishers (PanZoom — no `.selection`; Highlight — a
 * consumer, no field properties).
 */
export function introspectInteractor(
  source: object,
): { kind: MosaicProducerKind; fields: string[]; selection: object } | undefined {
  const s = source as InteractorShape;
  const selection = s.selection;
  if (selection === undefined || selection === null) return undefined;
  if (s.field != null && s.channel != null) {
    return { kind: "interval", fields: [fieldName(s.field)], selection };
  }
  if (s.xfield != null && s.yfield != null) {
    return { kind: "interval", fields: [fieldName(s.xfield), fieldName(s.yfield)], selection };
  }
  if (Array.isArray(s.fields)) {
    return { kind: "point", fields: s.fields.map(fieldName), selection };
  }
  return undefined;
}

function makeValueReader(source: object, selection: object): () => unknown {
  return () => {
    const sel = selection as { valueFor?: (s: object) => unknown };
    const published = sel.valueFor?.(source);
    if (published !== undefined) return published;
    return (source as { value?: unknown }).value;
  };
}

function register(key: string, entries: MosaicProducerEntry[]): () => void {
  const box = registry();
  const token = {};
  box.regs.set(key, { token, entries });
  box.bump();
  return () => {
    const current = box.regs.get(key);
    if (current?.token === token) {
      box.regs.delete(key);
      box.bump();
    }
  };
}

/**
 * Register every clause-publishing interactor of one Plot (including legend
 * handlers, which mosaic keeps OUT of `plot.interactors`). Called by
 * MosaicView when given `scope`/`name`; returns the unregister function.
 * A single publisher gets the bare name; several get `:<index>` suffixes.
 */
export function registerMosaicPlot(reg: {
  scope?: Scope | string;
  name: string;
  plot: MosaicPlotLike;
}): () => void {
  const scope = scopeName(reg.scope);
  const base = qualify(reg.scope, reg.name);
  const found: Omit<MosaicProducerEntry, "name">[] = [];
  for (const source of reg.plot.interactors) {
    const info = introspectInteractor(source);
    if (info === undefined) continue;
    found.push({
      ...(scope !== undefined ? { scope } : {}),
      host: "plot",
      kind: info.kind,
      fields: info.fields,
      source,
      selection: info.selection,
      value: makeValueReader(source, info.selection),
    });
  }
  const legends = reg.plot.legends ?? [];
  for (const l of legends) {
    const handler = l.legend?.handler;
    if (handler === undefined) continue;
    const info = introspectInteractor(handler);
    if (info === undefined) continue;
    found.push({
      ...(scope !== undefined ? { scope } : {}),
      host: "plot",
      kind: info.kind,
      fields: info.fields,
      source: handler,
      selection: info.selection,
      value: makeValueReader(handler, info.selection),
    });
  }
  const entries = found.map((e, i) => ({
    ...e,
    name: found.length === 1 ? base : `${base}:${i}`,
  }));
  return register(base, entries);
}

/**
 * Register one standalone input widget (a mosaic-inputs Menu/Slider/Search —
 * or anything clause-publishing built by hand). `fields`/`kind` override the
 * best-effort read of the instance's `field`/`column` properties.
 */
export function registerMosaicInput(reg: {
  scope?: Scope | string;
  name: string;
  input: object;
  selection?: object;
  fields?: string[];
  kind?: MosaicProducerKind;
}): () => void {
  const scope = scopeName(reg.scope);
  const name = qualify(reg.scope, reg.name);
  const s = reg.input as { selection?: object; field?: unknown; column?: unknown };
  const selection = reg.selection ?? s.selection;
  if (selection === undefined) {
    throw new Error(`registerMosaicInput "${name}": the input exposes no selection — pass one`);
  }
  const fallback = s.field ?? s.column;
  const fields = reg.fields ?? (fallback != null ? [fieldName(fallback)] : []);
  const entry: MosaicProducerEntry = {
    name,
    ...(scope !== undefined ? { scope } : {}),
    host: "input",
    kind: reg.kind ?? "point",
    fields,
    source: reg.input,
    selection,
    value: makeValueReader(reg.input, selection),
  };
  return register(name, [entry]);
}

/**
 * Reactive listing of the live producers — all of them, or a scope's view
 * (the shared membership rule: the scope's subtree plus unscoped entries).
 */
export function mosaicProducers(scope?: Scope | string): MosaicProducerEntry[] {
  const box = registry();
  box.version();
  const s = scopeName(scope);
  const view = s !== undefined ? surfaceViewFor(s) : undefined;
  const out: MosaicProducerEntry[] = [];
  for (const { entries } of box.regs.values()) {
    for (const e of entries) {
      if (view !== undefined && !view.owns(e.name)) continue;
      out.push(e);
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** @internal Test hook: drop every registration. */
export function clearMosaicProducerRegistry(): void {
  const box = registry();
  box.regs.clear();
  box.bump();
}
