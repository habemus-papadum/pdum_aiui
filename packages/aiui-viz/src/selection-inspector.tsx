/**
 * selection-inspector.tsx — observability for one Mosaic Selection: every
 * active clause with its PROVENANCE (which declared dimension, which
 * on-screen component), its value and its SQL, the resolved WHERE, and the
 * capability map — what could filter here, active or not, and through which
 * component. The model half is a plain reactive function so an app can wire
 * the same rows into its `report()` (the agent's view and the human's panel
 * stay one computation); the widget half renders it with the CSS-class
 * contract and no styles (the SelectionViewsBar convention).
 *
 * Provenance is identity-based, because that is all Mosaic gives us: a
 * clause's `source` is the producing instance. Dimension sources are the
 * stable durable objects mosaic-selection.ts mints (named `dim:<name>:<i>`);
 * component sources are matched against the live producer registry
 * (mosaic-registry.ts — MosaicView and registerMosaicInput fill it). A
 * clause matching neither is labeled by its constructor: real, filtering,
 * but unregistered — the inspector's job is to make that state VISIBLE, not
 * impossible.
 *
 * The capability grouping (by filtered column set) is the fluidity contract
 * made data: one member under "mag" means a spoken "magnitude above six"
 * has an unambiguous home; several members mean a clarifying question is
 * legitimate. Stage-3 facet adoption will consume the same grouping.
 */
import type { JSX } from "@solidjs/web";
import { For, Show } from "solid-js";
import { type MosaicProducerEntry, mosaicProducers } from "./mosaic-registry";
import {
  type SelectionDimSurfaceEntry,
  type SelectionSignal,
  selectionDimSurface,
} from "./mosaic-selection";
import type { Scope } from "./scope";

/** One active clause, attributed. */
export interface InspectorClauseRow {
  /** "dim" (a declared dimension), "component" (a registered producer),
   * or "unknown" (a live clause from an unregistered source). */
  origin: "dim" | "component" | "unknown";
  /** The attributed name ("seismos/mag", "seismos/map") or a class label. */
  producer: string;
  /** Columns the clause filters (best-effort). */
  fields: string[];
  /** The clause's data-space value. */
  value: unknown;
  /** The clause's own predicate as SQL text. */
  sql: string;
}

/** One filterable column set and everything that can drive it. */
export interface InspectorCapabilityRow {
  /** Sorted column names — the group key. */
  fields: string[];
  dims: { name: string; kind: string; value: unknown }[];
  producers: { name: string; host: string; kind: string; value: unknown; active: boolean }[];
}

export interface SelectionInspectorModel {
  clauses: InspectorClauseRow[];
  /** The resolved WHERE over all clauses ("TRUE" when unfiltered). */
  where: string;
  capabilities: InspectorCapabilityRow[];
}

const DIM_SOURCE = /^dim:(.*):\d+$/;

/** Parse a dimension source's durable name back to the dimension's name. */
function dimNameOf(source: object): string | undefined {
  const n = (source as { name?: unknown }).name;
  if (typeof n !== "string") return undefined;
  const m = DIM_SOURCE.exec(n);
  return m === null ? undefined : m[1];
}

function fieldsOfDim(entry: SelectionDimSurfaceEntry): string[] {
  return [...new Set(entry.targets.map((t) => t.field))];
}

/**
 * Build the inspector rows. Reactive by construction — call it inside JSX or
 * a memo: it reads the selection signal (clauses, SQL), the dimension
 * surface (values), and the producer registry (registrations).
 */
export function selectionInspectorModel(opts: {
  signal: SelectionSignal;
  scope?: Scope | string;
}): SelectionInspectorModel {
  const dims = selectionDimSurface(opts.scope);
  const producers = mosaicProducers(opts.scope);
  const clauses = opts.signal.clauses();

  const bySource = new Map<object, MosaicProducerEntry>();
  for (const p of producers) bySource.set(p.source, p);

  const rows: InspectorClauseRow[] = clauses.map((c) => {
    const sql = String(c.predicate ?? "");
    const dimName = dimNameOf(c.source);
    if (dimName !== undefined) {
      const dim = dims.find((d) => d.name === dimName);
      return {
        origin: "dim",
        producer: dimName,
        fields: dim !== undefined ? fieldsOfDim(dim) : [],
        value: c.value,
        sql,
      };
    }
    const entry = bySource.get(c.source);
    if (entry !== undefined) {
      return {
        origin: "component",
        producer: entry.name,
        fields: entry.fields,
        value: c.value,
        sql,
      };
    }
    const ctor = (c.source as { constructor?: { name?: string } }).constructor?.name;
    return {
      origin: "unknown",
      producer: ctor !== undefined && ctor !== "Object" ? ctor : "unregistered source",
      fields: [],
      value: c.value,
      sql,
    };
  });

  const groups = new Map<string, InspectorCapabilityRow>();
  const groupFor = (fields: string[]): InspectorCapabilityRow => {
    const sorted = [...new Set(fields)].sort();
    const key = sorted.join("+");
    let g = groups.get(key);
    if (g === undefined) {
      g = { fields: sorted, dims: [], producers: [] };
      groups.set(key, g);
    }
    return g;
  };
  for (const d of dims) {
    groupFor(fieldsOfDim(d)).dims.push({ name: d.name, kind: d.kind, value: d.value });
  }
  const activeSources = new Set(clauses.map((c) => c.source));
  for (const p of producers) {
    groupFor(p.fields).producers.push({
      name: p.name,
      host: p.host,
      kind: p.kind,
      value: p.value(),
      active: activeSources.has(p.source),
    });
  }

  return {
    clauses: rows,
    where: opts.signal.sql(),
    capabilities: [...groups.values()].sort((a, b) =>
      a.fields.join("+").localeCompare(b.fields.join("+")),
    ),
  };
}

/** Compact value text: numbers rounded so brush extents stay readable. */
export function formatInspectorValue(v: unknown): string {
  if (v === null || v === undefined) return "—";
  const round = (x: unknown): unknown => {
    if (typeof x === "number") return Number.isInteger(x) ? x : Number(x.toFixed(3));
    if (Array.isArray(x)) return x.map(round);
    return x;
  };
  return JSON.stringify(round(v));
}

/**
 * The panel: active clauses with provenance and SQL, the resolved WHERE,
 * and the capability map. No styles ship — the class contract is
 * `selection-inspector` on the root; `inspector-clause` rows (stamped
 * `data-origin="dim|component|unknown"`) with `inspector-producer` /
 * `inspector-fields` / `inspector-value` / `inspector-sql` inside;
 * `inspector-where`; `inspector-capability` rows (`data-active` on live
 * members) with `capability-fields` / `capability-member`.
 */
export function SelectionInspector(props: {
  signal: SelectionSignal;
  scope?: Scope | string;
  class?: string;
}): JSX.Element {
  const model = () => selectionInspectorModel({ signal: props.signal, scope: props.scope });
  return (
    <div class={props.class ? `selection-inspector ${props.class}` : "selection-inspector"}>
      <div class="inspector-clauses">
        <Show
          when={model().clauses.length > 0}
          fallback={<div class="inspector-empty">no active filters</div>}
        >
          <For each={model().clauses}>
            {(row) => (
              <div class="inspector-clause" data-origin={row.origin}>
                <span class="inspector-producer">{row.producer}</span>
                <span class="inspector-fields">{row.fields.join(", ")}</span>
                <span class="inspector-value">{formatInspectorValue(row.value)}</span>
                <code class="inspector-sql">{row.sql}</code>
              </div>
            )}
          </For>
        </Show>
      </div>
      <Show when={model().clauses.length > 1}>
        <code class="inspector-where">{model().where}</code>
      </Show>
      <div class="inspector-capabilities">
        <For each={model().capabilities}>
          {(cap) => (
            <div class="inspector-capability">
              <span class="capability-fields">{cap.fields.join(", ")}</span>
              <For each={cap.dims}>
                {(d) => (
                  <span
                    class="capability-member"
                    data-kind="dim"
                    data-active={d.value !== null ? "" : undefined}
                  >
                    {d.name}
                  </span>
                )}
              </For>
              <For each={cap.producers}>
                {(p) => (
                  <span
                    class="capability-member"
                    data-kind={p.host}
                    data-active={p.active ? "" : undefined}
                  >
                    {p.name}
                  </span>
                )}
              </For>
            </div>
          )}
        </For>
      </div>
    </div>
  );
}
