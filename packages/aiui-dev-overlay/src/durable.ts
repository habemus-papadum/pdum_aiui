/**
 * A registry for overlay resources that must outlive a *soft* remount — the
 * MutationObserver in the Vite mount module re-runs `mountIntentTool` whenever
 * the app rebuilds `document.body`, and a fresh mount should ADOPT the live
 * turn rather than recreate it. This is the durable/disposable line from the
 * frontend-design methodology (`docs/guide/frontend-for-agents.md`), applied to
 * the overlay itself.
 *
 * **Deliberate duplication.** aiui-viz already ships `durable()`
 * (`packages/aiui-viz/src/durable.ts`), but that package depends on SolidJS and
 * the overlay is a hard-constraint dependency-free vanilla-TS module — importing
 * it would drag Solid into every page the overlay touches. So the ~30-line
 * contract is reimplemented here. Same semantics (create-once, adopt-forever);
 * the only difference is where the registry lives: aiui-viz keeps it at
 * `window.__aiuiDurable`, ours rides the overlay's existing `window.__AIUI__`
 * instrumentation global so there is one aiui home. It is stashed as a
 * **non-enumerable** property so the DevTools panel's JSON serialization of
 * `window.__AIUI__` (see instrumentation.ts) never walks into it.
 *
 * Scope note: a durable-on-`window` registry survives a soft remount but NOT a
 * full page reload (the overlay has no HMR self-accept, so an overlay-source
 * edit under a dev server full-reloads — see turn-store.ts for the finding and
 * the sessionStorage fallback that carries the turn across that reload).
 */
import { getInstrumentation, type PageInstrumentation } from "./instrumentation";

interface DurableHost {
  /** The create-once registry; non-enumerable so panel serialization skips it. */
  __durable?: Map<string, unknown>;
}

/** The registry map on `window.__AIUI__`, created lazily; undefined without a DOM. */
function entries(): Map<string, unknown> | undefined {
  const inst = getInstrumentation() as (PageInstrumentation & DurableHost) | undefined;
  if (!inst) {
    return undefined;
  }
  if (!inst.__durable) {
    Object.defineProperty(inst, "__durable", {
      value: new Map<string, unknown>(),
      enumerable: false,
      configurable: true,
    });
  }
  return inst.__durable;
}

/**
 * Create-or-adopt a durable resource. `create` runs at most once per page; every
 * later call (including from a re-run mount) returns the same instance. Without
 * a DOM it is transparent — it just runs `create` with no persistence.
 */
export function durable<T>(key: string, create: () => T): T {
  const map = entries();
  if (!map) {
    return create();
  }
  if (!map.has(key)) {
    map.set(key, create());
  }
  return map.get(key) as T;
}

/**
 * Forget one durable resource for real (not a remount adoption): runs `dispose`
 * and drops the entry, so the next `durable(key, …)` creates fresh.
 */
export function disposeDurable(key: string, dispose?: (value: unknown) => void): void {
  const map = entries();
  if (map?.has(key)) {
    dispose?.(map.get(key));
    map.delete(key);
  }
}
