/**
 * hot-graph.ts — one call that owns the whole "durable roots, disposable graph"
 * ritual, so an app's graph module is nothing but its cells.
 *
 * The HMR discipline (see durable.ts) splits an app in two: `store.ts` holds
 * the *durable roots* (parameters, workers, GPU contexts) and `graph.ts` holds
 * the *disposable* cell graph built over them. On a hot edit the graph module
 * re-evaluates: it must dispose the previous graph and build a fresh one over
 * the same roots, and it must self-accept so the update stops there instead of
 * bubbling up to a full reload.
 *
 * That ritual is identical in every app, and was copy-pasted into every one of
 * them — a durable box holding `{ graph, dispose }`, a `dispose(); set(build())`
 * at module scope, an `import.meta.hot.accept()`. `hotCellGraph` is that ritual.
 *
 * ## Why `hot` is a parameter and not something we read ourselves
 *
 * Two constraints, both paid for (docs/guide/frontend-hard-won):
 *
 *   1. `import.meta.hot.accept()` registers a self-accept for *the module that
 *      owns that `hot` object*. A library cannot self-accept on a caller's
 *      behalf — there is no "current module" to ask for.
 *   2. `import.meta.*` is resolved when a module is **transformed**. Prebuilt
 *      `dist/` library code never receives a hot context from the consumer's
 *      dev server, so `import.meta.hot` written *here* would be permanently
 *      undefined for every installed consumer. (Same failure class as
 *      `import.meta.env.*` in a published package — the reason the aiui()
 *      source processor integrates as a Vite plugin.)
 *
 * But `hot` only has to be *named* by the caller, not *used* by them: it is a
 * plain object whose `accept` is bound to the caller's module URL. Passing it in
 * lets us call `hot.accept()` while Vite still registers the self-accept against
 * `graph.ts`. Hence the one-argument tail:
 *
 * ```ts
 * export const graph = hotCellGraph<AppGraph>("app", () => ({
 *   rose: cell(() => ({ n: petals.get() }), async (p) => buildRose(p)),
 * }), import.meta.hot);
 * ```
 *
 * Omit `hot` (or pass `undefined`) and everything works minus hot-swapping —
 * which is exactly what a production build wants.
 */

import { type Accessor, createSignal } from "solid-js";
import { cellGraph } from "./cell";
import { durable } from "./durable";

/**
 * Structural stand-in for Vite's `import.meta.hot`. Declared locally rather
 * than imported from `vite/client` so aiui-viz stays free of a build-tool type
 * dependency.
 */
export interface HotContext {
  accept(callback?: (module: unknown) => void): void;
}

interface GraphEntry<G> {
  graph: G;
  dispose: () => void;
}

/**
 * The durable publication point for one key.
 *
 * `entry` is a **plain field, not a signal value**, and that is load-bearing:
 * Solid 2.0 commits signal writes transactionally, so a `get()` in the same
 * synchronous tick as its `set()` still returns the OLD value (see
 * docs/guide/frontend-hard-won, "Same-tick reads after writes lie"). A graph
 * module's `main.tsx` imports it and calls `render()` in that same tick, so a
 * signal-valued box reads `undefined` on the very first render — which is why
 * every hand-rolled version of this needed a `<Show when={graph()}>` guard for
 * a state that conceptually cannot exist.
 *
 * So the value lives in `entry` (always fresh, written before the notify) and
 * `version` exists only to make reads reactive. Consumers subscribe to
 * `version` and dereference `entry`.
 */
interface GraphBox<G> {
  version: Accessor<number>;
  bump: (next: (v: number) => number) => void;
  entry: GraphEntry<G> | undefined;
}

/**
 * Build a cell graph that survives hot edits.
 *
 * Disposes the previous graph (if this module is re-evaluating), builds a new
 * one over the durable roots via {@link cellGraph}, publishes it through a
 * durable box, and self-accepts the HMR update when handed a `hot` context.
 *
 * Returns a **stable accessor** that components read on every access —
 * `graph().rose`, never a module-level cell export — so no component can hold a
 * reference to a disposed graph across a swap. The accessor is reactive: a hot
 * swap re-renders every consumer.
 *
 * The return type is `Accessor<G>`, not `Accessor<G | undefined>`: the graph is
 * built synchronously before this function returns, and reads never route
 * through a signal's value (see {@link GraphBox}). Consumers need no
 * `<Show when={graph()}>` guard for a state that cannot occur.
 *
 * @param key   Namespace for the durable box. One per page in a multi-notebook
 *              app (`"morphogen"`, `"seismos"`); they share one registry.
 * @param build Runs inside `createRoot` — create cells and effects here.
 * @param hot   The calling module's `import.meta.hot`. See the note above.
 */
export function hotCellGraph<G>(key: string, build: () => G, hot?: HotContext): Accessor<G> {
  const box = durable(`aiui:graph:${key}`, () => {
    // ownedWrite: the bump below is legitimate bookkeeping, and hotCellGraph may
    // be called from an owned scope (a test's createRoot, a component).
    const [version, bump] = createSignal(0, { ownedWrite: true });
    return { version, bump, entry: undefined };
  }) as GraphBox<G>;

  box.entry?.dispose(); // an HMR re-evaluation swaps the previous graph out
  box.entry = cellGraph(build); // fresh to synchronous readers immediately…
  box.bump((v) => v + 1); // …and to reactive ones on the next commit

  // Self-accept: absorb this update instead of letting it bubble to a reload.
  // Bare `accept()` is enough — re-evaluating this module *is* the swap.
  hot?.accept();

  return () => {
    box.version(); // subscribe: a hot swap re-runs every consumer
    return (box.entry as GraphEntry<G>).graph;
  };
}
