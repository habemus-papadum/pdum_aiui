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

import { type Accessor, createSignal, getObserver, type Setter } from "solid-js";

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

    // The stale-read guard (write-semantics proposal M6). Solid 2.0 STAGES
    // writes until the next microtask, and a read outside a reactive scope
    // returns the last COMMITTED value — so "set then get" in one synchronous
    // flow silently reads the pre-write value. That bug was found live seven
    // times before it was understood, and LLM priors (trained on Solid 1.x,
    // which had read-your-own-writes behind the identical API) regenerate it
    // on every new file. Documentation cannot outrank a prior; only something
    // that fails loudly can. So: when a boundary read would return a value
    // that DIFFERS from what this same tick wrote, shout, with the fix in the
    // message. Reads inside the graph (memos, effect computes, JSX) never
    // warn — they see staged values and are always safe. Reads after flush()
    // or a microtask never warn — the values agree by then. The check is two
    // comparisons; it stays on in prod builds (this library must not read
    // `import.meta.env`, and the hazard is exactly as wrong in prod).
    let pendingWrite = false;
    let lastWritten: T;
    const guardedSet = ((next?: unknown) => {
      const written = (set as (v: unknown) => T)(next);
      lastWritten = written;
      pendingWrite = true;
      queueMicrotask(() => {
        pendingWrite = false;
      });
      return written;
    }) as Setter<T>;
    const guardedGet: Accessor<T> = () => {
      const value = get();
      if (pendingWrite && getObserver() === null && !Object.is(value, lastWritten)) {
        console.error(
          `[aiui] "${key}" was written earlier in this same tick and is being read outside a ` +
            `reactive scope — this read returns the PRE-write value (${JSON.stringify(value)}, ` +
            `not ${JSON.stringify(lastWritten)}). Branch on the value you wrote (or the ` +
            "setter's return), or flush() first. See docs/guide/frontend-hard-won.md",
        );
      }
      return value;
    };
    return { get: guardedGet, set: guardedSet };
  });
}
