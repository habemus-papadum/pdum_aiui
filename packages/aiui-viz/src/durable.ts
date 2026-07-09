/**
 * durable.ts — a registry for resources that must outlive a module reload.
 *
 * The HMR discipline (archive/agentic_ui_workflow/hmr_for_agentic_coding.md):
 * draw a bright line between *durable state* (the WebGL field, the running
 * worker, accumulated history, the user's parameter settings) and *disposable
 * logic* (render functions, cell computes, shaders). A module re-evaluation
 * must ADOPT existing resources, never double-create them — the leaked
 * duplicate is the single hardest HMR bug.
 *
 * `durable(key, create)` is idempotent: the first call creates, every later
 * call (including from a re-evaluated module) returns the same instance. The
 * registry lives on `window` so it survives any module graph churn; it is
 * dev-tool state, same spirit as the observability handles.
 */

import { type Accessor, createSignal, type Setter } from "solid-js";

interface DurableRegistry {
  entries: Map<string, unknown>;
}

function registry(): DurableRegistry {
  const w = window as unknown as { __aiuiDurable?: DurableRegistry };
  w.__aiuiDurable ??= { entries: new Map() };
  return w.__aiuiDurable;
}

/** Create-or-adopt a durable resource. `create` runs at most once per page. */
export function durable<T>(key: string, create: () => T): T {
  const reg = registry();
  if (!reg.entries.has(key)) {
    reg.entries.set(key, create());
  }
  return reg.entries.get(key) as T;
}

/**
 * Tear down one durable resource for real (not an HMR swap): runs `dispose`
 * and forgets the entry, so the next `durable(key, …)` creates fresh.
 */
export function disposeDurable(key: string, dispose?: (value: unknown) => void): void {
  const reg = registry();
  if (reg.entries.has(key)) {
    dispose?.(reg.entries.get(key));
    reg.entries.delete(key);
  }
}

/** A signal that survives hot edits: `{ get, set }` rather than a tuple. */
export interface SignalBox<T> {
  get: Accessor<T>;
  set: Setter<T>;
}

/**
 * The durable roots of an app are almost always signals — the slider position,
 * the selected sample, the camera. `durableSignal` is `createSignal` wrapped in
 * `durable()`: created once, *adopted* by every re-evaluated module, so a hot
 * edit never resets what the user touched.
 *
 * ```ts
 * export const angleStep = durableSignal("param:angleStep", 71);
 * ```
 *
 * Keys share one page-wide namespace (the durable registry), so prefix them per
 * page in a multi-notebook app: `durableSignal("seismos:year", 1994)`.
 */
export function durableSignal<T>(
  key: string,
  // biome-ignore lint/complexity/noBannedTypes: mirrors createSignal's own Exclude<T, Function> overload
  initial: Exclude<T, Function>,
): SignalBox<T> {
  return durable(key, () => {
    const [get, set] = createSignal<T>(initial);
    return { get, set };
  });
}
