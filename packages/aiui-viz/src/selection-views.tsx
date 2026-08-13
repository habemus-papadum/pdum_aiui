/**
 * selection-views.tsx — named cross-filter views: snapshot every selection
 * dimension's SEMANTIC VALUE under a name, restore it later — by mouse
 * (the {@link SelectionViewsBar} widget) or by agent (the four auto-registered
 * actions), which are deliberately the same code path.
 *
 * A view serializes dimension VALUES (`{ "seismos/mag": { lo: 5 }, … }`),
 * never Mosaic clauses: clauses carry live source objects and prebuilt SQL
 * that go stale the moment code moves, while a dimension value is plain,
 * human-readable JSON whose restore path — `dim.set(value)` — is byte-
 * identical to an agent set. Nulls are stored too: a view is COMPLETE filter
 * state — and loading treats it that way: every selection the dimensions
 * target is `reset()` FIRST (dropping every producer's clause, mouse brushes
 * and menus included, and clearing their visuals through `source.reset()`),
 * then the snapshot is applied. Loading a view therefore lands on exactly the
 * saved state, not the saved state AND'd under whatever the mouse had piled
 * on since (the measured confusion that forced this rule). What a view does
 * NOT capture: non-dimension clause VALUES (a vgplot brush, a menu pick) —
 * those have no serializable identity; until a dimension (or a stage-3 facet)
 * speaks for them, saving loses them and loading clears them.
 *
 * Storage is localStorage, keyed per scope (`aiui:views:<scope>`). This is
 * deliberately the FIRST persist-across-reload state in aiui-viz — durables
 * are in-memory by design (durable.ts) — so it lives in its own module behind
 * its own key, and everything else keeps the reload-resets-state contract.
 * Reads tolerate corruption (a bad payload reads as "no views"); writes are
 * best-effort (quota/private-mode failures warn, never throw).
 *
 * `selectionViews()` is durable-adopted: every call for the same scope
 * returns the SAME store (so the widget and the actions share one reactive
 * list), and the four actions — `save-view`, `load-view`, `list-views`,
 * `delete-view` — register once per page, scope-qualified, with real JSON
 * Schemas (the oracle and page_tools_call see them with zero app wiring).
 */
import type { JSX } from "@solidjs/web";
import { createSignal, For } from "solid-js";
import { action } from "./control";
import { durable } from "./durable";
import {
  resetSelectionDimTargets,
  selectionDimByName,
  selectionDimReport,
} from "./mosaic-selection";
import type { Scope } from "./scope";

/** One saved view: a complete dimension-value snapshot under a name. */
export interface SavedSelectionView {
  name: string;
  /** ISO timestamp of the save. */
  savedAt: string;
  /** Dimension qualified name → semantic value (nulls included). */
  values: Record<string, unknown>;
}

/** The named-views store for one scope (see {@link selectionViews}). */
export interface SelectionViewsStore {
  /** The owning scope's name — also the storage-key discriminator. */
  readonly scope: string;
  /** Reactive: saved view names, alphabetical. */
  names(): string[];
  /** Reactive: full saved records, alphabetical by name. */
  views(): SavedSelectionView[];
  /** Snapshot the scope's current dimension values under `name` (replaces an
   * existing view of that name). Returns the record written. */
  save(name: string): SavedSelectionView;
  /** Restore a saved view: every selection the scope's dimensions target is
   * reset (all producers' clauses AND visuals cleared), then every
   * snapshotted dimension is set (null clears). Returns what was APPLIED per
   * dimension, plus snapshot entries whose dimension no longer exists.
   * Throws on an unknown view name. */
  load(name: string): { name: string; applied: Record<string, unknown>; missing: string[] };
  /** Delete a saved view. Returns whether it existed. */
  remove(name: string): boolean;
}

interface StorageShape {
  v: 1;
  views: Record<string, { savedAt: string; values: Record<string, unknown> }>;
}

function readStorage(key: string): StorageShape {
  try {
    const raw = localStorage.getItem(key);
    if (raw !== null) {
      const parsed = JSON.parse(raw) as StorageShape;
      if (parsed && parsed.v === 1 && typeof parsed.views === "object" && parsed.views !== null) {
        return parsed;
      }
    }
  } catch {
    // Corrupt payload or no storage: treat as empty rather than breaking the page.
  }
  return { v: 1, views: {} };
}

function writeStorage(key: string, data: StorageShape): void {
  try {
    localStorage.setItem(key, JSON.stringify(data));
  } catch (err) {
    console.warn(`aiui: could not persist views to localStorage ("${key}")`, err);
  }
}

/**
 * Create (or adopt) the named-views store for a scope, and register its four
 * agent actions. Durable-adopted: one store per scope per page, so the widget
 * and the actions share one reactive list. Call it once in the store module:
 *
 * ```ts
 * export const views = selectionViews({ scope: appScope });
 * ```
 */
export function selectionViews(options: {
  scope: Scope | string;
  /** Storage key override; defaults to `aiui:views:<scope>`. Fixed at first
   * call — the store is durable-adopted. */
  storageKey?: string;
}): SelectionViewsStore {
  const scope = options.scope;
  const scopeName = typeof scope === "string" ? scope : scope.name;
  return durable(`views:${scopeName}`, () => {
    const key = options.storageKey ?? `aiui:views:${scopeName}`;
    const [version, setVersion] = createSignal(0);
    const bump = () => setVersion((v) => v + 1);

    const store: SelectionViewsStore = {
      scope: scopeName,
      names: () => {
        version();
        return Object.keys(readStorage(key).views).sort();
      },
      views: () => {
        version();
        const data = readStorage(key).views;
        return Object.keys(data)
          .sort()
          .map((name) => ({ name, ...data[name] }));
      },
      save: (name) => {
        const trimmed = name.trim();
        if (trimmed === "") throw new Error("save-view: the view needs a non-empty name");
        const record = {
          savedAt: new Date().toISOString(),
          values: selectionDimReport(scopeName),
        };
        const data = readStorage(key);
        data.views[trimmed] = record;
        writeStorage(key, data);
        bump();
        return { name: trimmed, ...record };
      },
      load: (name) => {
        const data = readStorage(key).views;
        const record = data[name];
        if (record === undefined) {
          const known = Object.keys(data).sort().join(", ");
          throw new Error(`no view "${name}" — saved views: ${known || "(none saved)"}`);
        }
        // Reset-then-apply: a view is complete state. Resetting the target
        // selections retracts EVERY producer's clause (and clears their
        // visuals via source.reset()); dimensions the snapshot names are then
        // re-set — their boxes take the reset's null and the applied value in
        // the same staged tick, applied last, so the applied value wins.
        resetSelectionDimTargets(scopeName);
        const applied: Record<string, unknown> = {};
        const missing: string[] = [];
        for (const [dimName, value] of Object.entries(record.values)) {
          const dim = selectionDimByName(dimName);
          if (dim === undefined) missing.push(dimName);
          else applied[dimName] = dim.set(value as never);
        }
        return { name, applied, missing };
      },
      remove: (name) => {
        const data = readStorage(key);
        const existed = name in data.views;
        if (existed) {
          delete data.views[name];
          writeStorage(key, data);
          bump();
        }
        return existed;
      },
    };

    registerViewActions(store, typeof scope === "string" ? undefined : scope);
    return store;
  });
}

/** The four derived verbs — PREBUILT specs (the compiler leaves them alone;
 * names are explicit), registered once per scope at store creation. */
function registerViewActions(store: SelectionViewsStore, scope: Scope | undefined): void {
  const nameArg = {
    type: "object",
    properties: { name: { type: "string", minLength: 1, description: "the view's name" } },
    required: ["name"],
    additionalProperties: false,
  };
  const scoped = scope !== undefined ? { scope } : {};
  action({
    ...scoped,
    name: "save-view",
    description:
      "Save the current cross-filter state — every selection dimension's value, unfiltered " +
      "ones included — as a named view (persisted locally; survives reload; same name " +
      "overwrites). Returns the snapshot written.",
    inputSchema: nameArg,
    run: (args) => store.save(String(args?.name ?? "")),
  });
  action({
    ...scoped,
    name: "load-view",
    description:
      "Restore a saved view by name: the cross-filter is reset first (every clause from " +
      "every producer — mouse brushes and menus included — is dropped), then every " +
      "snapshotted dimension is applied, so the page returns to exactly the saved filter " +
      "state. Returns { applied, missing }. Counts refresh after a task boundary; re-read " +
      "report() then.",
    inputSchema: nameArg,
    run: (args) => store.load(String(args?.name ?? "")),
  });
  action({
    ...scoped,
    name: "list-views",
    description: "List the saved cross-filter views: name, savedAt, and the values each holds.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: () => ({ views: store.views() }),
  });
  action({
    ...scoped,
    name: "delete-view",
    description: "Delete a saved cross-filter view by name. Returns { removed: true | false }.",
    inputSchema: nameArg,
    run: (args) => {
      const name = String(args?.name ?? "");
      return { name, removed: store.remove(name) };
    },
  });
}

/**
 * The mouse half of named views — a small bar an app drops beside its other
 * controls: a picker that LOADS on choose, a name field + save button, and a
 * delete button for the picked view. Drives the exact same store methods the
 * agent actions call, so voice and mouse stay equals. No styles ship (the
 * CSS-class contract, like ControlSlider): `selection-views` on the root,
 * `views-select` / `views-name` / `views-save` / `views-delete` inside.
 */
export function SelectionViewsBar(props: {
  store: SelectionViewsStore;
  /** Extra class(es) appended after "selection-views" (layout variants). */
  class?: string;
}): JSX.Element {
  const [picked, setPicked] = createSignal("");
  const [draft, setDraft] = createSignal("");
  const saveDraft = () => {
    const name = draft().trim();
    if (name === "") return;
    props.store.save(name);
    setPicked(name);
    setDraft("");
  };
  return (
    <div class={props.class ? `selection-views ${props.class}` : "selection-views"}>
      <select
        class="views-select"
        value={picked()}
        onInput={(e) => {
          const name = e.currentTarget.value;
          setPicked(name);
          if (name !== "") props.store.load(name);
        }}
      >
        <option value="">— saved views —</option>
        <For each={props.store.names()}>{(name) => <option value={name}>{name}</option>}</For>
      </select>
      <input
        class="views-name"
        type="text"
        placeholder="save view as…"
        value={draft()}
        onInput={(e) => setDraft(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") saveDraft();
        }}
      />
      <button type="button" class="views-save" onClick={saveDraft} disabled={draft().trim() === ""}>
        save
      </button>
      <button
        type="button"
        class="views-delete"
        onClick={() => {
          const name = picked();
          if (name !== "") {
            props.store.remove(name);
            setPicked("");
          }
        }}
        disabled={picked() === ""}
      >
        delete
      </button>
    </div>
  );
}
