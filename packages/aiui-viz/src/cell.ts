/**
 * cell.ts — Observable-style async dataflow cells for SolidJS 2.0 (beta).
 *
 * Taken from the repo's reactive-flows design (the solid-cells design notes,
 * git history), where every behavior here was established by probe against
 * solid-js 2.0.0-beta.15. Solid 2.0 made async first-class:
 * memos accept promises and async iterables, the graph suspends/resumes
 * consumers, commits are transactional, stale values are served while new
 * work is pending, superseded runs are discarded and their `onCleanup`s fire.
 *
 * What a cell still adds on top of a raw `createMemo`:
 *   - AbortSignal plumbing (`ctx.signal`) — aborted when a run is superseded
 *     or the owner is disposed, so fetches/workers actually stop.
 *   - Progress reporting (`ctx.progress`) — the framework has no notion.
 *   - `settled()` — Solid commits each yield of an async iterable as a
 *     first-class value, so `isPending()` is false *between* yields; a cell
 *     tracks whether the current run has finished, which is what loading UI
 *     actually wants.
 *   - Non-throwing introspection: `state()` / `latest()` / `error()`.
 *   - deps gating: `deps` returning undefined/null/false holds the cell.
 *   - Retry: `refetch()` uses the error boundary's reset when errored,
 *     `refresh(memo)` otherwise.
 *   - One `equals` gate for what counts as a new value, applied to the graph
 *     read and to `latest()` alike (reference identity by default).
 */
import {
  type Accessor,
  createMemo,
  createRoot,
  createSignal,
  getOwner,
  NotReadyError,
  onCleanup,
  refresh,
  untrack,
} from "solid-js";
// The primitive behind `<Errored>`, on `solid-js/internal` since the 2.0
// release candidates (cells wrap state derivation in it — see the module doc).
import { createErrorBoundary } from "solid-js/internal";
import { dropConsumer, recordRead, runAsConsumer } from "./graph-trace";
import type { Scope } from "./scope";

export type CellState =
  | "unresolved" // never had a value; deps gate closed or upstream not ready
  | "pending" // never had a value; first run in flight
  | "streaming" // has a value; current run still yielding
  | "refreshing" // has a value; a newer run is pending or an upstream is recomputing
  | "held" // has a value; the deps gate is CLOSED — nothing is running or coming
  | "ready"
  | "errored";

export interface CellContext<T> {
  /** Aborted when a newer run supersedes this one, or the owner is disposed. */
  signal: AbortSignal;
  /** Report progress in [0, 1]; resets to undefined at the start of each run. */
  progress: (fraction: number) => void;
  /** The previous settled value, if any — useful for warm starts. */
  previous: T | undefined;
}

export type CellCompute<D, T> = (deps: D, ctx: CellContext<T>) => T | Promise<T> | AsyncIterable<T>;

export interface CellOptions<T = unknown> {
  /**
   * Stable identity for attribution and the cell registry. Normally you never
   * write this: the aiui compiler (the source-locator babel pass) injects
   * `name` (from the declaration, e.g. `const catalog = cell(…)` → "catalog")
   * and `loc` ("src/model/graph.ts:77") at compile time — in dev AND
   * production builds; identity injection is load-bearing. Named cells
   * register themselves (see cellRegistry) and CellView stamps `data-cell`
   * with the name — the element → cell attribution contract.
   */
  name?: string;
  /**
   * Instance qualifier for slice factories (scope.ts): the registered name —
   * and so the `data-cell` stamp, the edges, and the report entry — becomes
   * `<scope>/<name>`, so a cells factory instantiated twice yields two
   * distinctly-named cells. The compiler still injects the LEAF name.
   */
  scope?: Scope;
  /** Definition site "file:line"; injected alongside `name`. */
  loc?: string;
  /**
   * Human description for the registry and the agent-facing report. Normally
   * lifted by the aiui compiler from the leading doc comment above the
   * declaration (the JSDoc convention); an explicit value here wins.
   */
  description?: string;
  /**
   * How async-iterable computes stream:
   * - "commit" (default): every yield is committed to the graph — downstream
   *   cells recompute per partial (Observable generator semantics).
   * - "latest": partials are visible only on `latest()`/`progress()`; the
   *   graph commits once, on the final value. Use when downstream work is
   *   expensive. Caveat (solid 2.0.0-beta.32, probed 2026-08-10): while a
   *   downstream consumer is PENDING on this cell — its deps read threw
   *   NotReadyError and it awaits the single commit — the in-flight run's
   *   writes are staged into the pending question's transaction, so latest()
   *   coalesces to the settle value for every reader. With no pending
   *   consumer (the side channel's real use: UI observing a run whose
   *   consumers already hold a previous value, or none exist yet), partials
   *   stream per yield. Pinned by the two latest-mode tests in cell.test.ts.
   */
  stream?: "commit" | "latest";
  /**
   * When a run's result counts as a CHANGE. Default: reference identity —
   * Solid's own memo rule — so a recompute that returns the same reference
   * tells nobody. Pass a comparator to close the gate on structurally equal
   * results (a cell that re-derives an identical array from a ticking source
   * keeps its consumers quiet), or `false` to notify on every result, even
   * the same reference (a stream that mutates one buffer in place and
   * re-yields it). One gate governs both channels — the graph read `cell()`
   * and the side channel `latest()` — so which channel a consumer reads never
   * changes what counts as new; streaming yields pass through it one at a
   * time, each against the last value that channel served. When the gate
   * closes, the previous value stands on both channels (`latest()` keeps the
   * old reference, exactly as the memo does). Run bookkeeping is never gated:
   * `state()`, `settled()` and `progress()` still report a run that
   * reproduced its last value.
   */
  equals?: false | ((prev: T, next: T) => boolean);
}

export interface Cell<T> {
  /**
   * The reactive read. Inside tracked scopes it throws NotReadyError before
   * the first value and while a newer run is pending — which is precisely how
   * downstream consumers hold and stay glitch-free. For UI that should keep
   * rendering the previous value, read latest() instead.
   */
  (): T;
  /** Last value produced by any run (kept across errors); never throws. */
  latest: Accessor<T | undefined>;
  state: Accessor<CellState>;
  /** True while pending, streaming, or refreshing. */
  loading: Accessor<boolean>;
  error: Accessor<unknown>;
  /** Progress of the current run in [0, 1], or undefined if not reported. */
  progress: Accessor<number | undefined>;
  /** False while the current run is still producing values. */
  settled: Accessor<boolean>;
  /** Re-run: error-boundary reset when errored, refresh(memo) otherwise. */
  refetch: () => void;
  /**
   * Identity for attribution (see CellOptions.name). Named `cellName` because
   * a cell is callable, and assigning to a function's `name` throws — the
   * built-in Function.name is read-only (a paid-for finding: before the
   * rename, every data-cell stamp read "read", the internal closure's
   * inferred function name).
   */
  cellName?: string;
  /** Definition site "file:line". */
  loc?: string;
  /** Human description (compiler-lifted from the doc comment, or explicit). */
  description?: string;
}

// --- the cell registry: name → live cell, for attribution -------------------
//
// Module state is per-page (each notebook entry is its own window), so no
// namespacing is needed here. Cells deregister when their owner is disposed —
// a graph hot-swap replaces the whole population atomically, which makes the
// registry HMR-correct with no extra bookkeeping.

const registry = new Map<string, Cell<unknown>>();

// Mirror a name→definition-site lookup on `window` for DOM-contract consumers
// that must stay framework-agnostic: a host's jump-to-source or selection
// resolver (the former intent tool's jump mode and its cell-source ladder were
// the first) resolves a bare `data-cell="name"` stamp (the one manual
// attribution attribute) to the cell's `cell(...)` definition site through
// this, without importing aiui-viz (see packages/aiui-viz/docs/attribution.md).
// Read-only and deliberately tiny; guarded because the barrel is imported
// from workers and node-side tests where `window` doesn't exist.
if (typeof window !== "undefined") {
  (
    window as unknown as {
      __aiuiCells?: {
        loc(name: string): string | undefined;
        state(name: string): string | undefined;
      };
    }
  ).__aiuiCells = {
    loc: (name) => registry.get(name)?.loc,
    // The live state too, for the page's own selection reader (page-selection.ts).
    state: (name) => registry.get(name)?.state(),
  };
}

/** Snapshot of every live named cell — the agent-facing attribution table. */
export function cellRegistry(): Array<{
  name: string;
  loc: string | undefined;
  description: string | undefined;
  state: CellState;
  settled: boolean;
}> {
  return [...registry.entries()].map(([name, c]) => ({
    name,
    loc: c.loc,
    description: c.description,
    state: c.state(),
    settled: c.settled(),
  }));
}

/** Look up a live cell by its attribution name. */
export function cellByName(name: string): Cell<unknown> | undefined {
  return registry.get(name);
}

/** What the error boundary derives: the cell's state, plus the error when errored. */
type Box = { readonly state: CellState; readonly error?: unknown };

// One frozen box per non-error state. The box is the value of the error
// boundary's internal computeds (Solid names them children / boundary / value),
// and their equality gate is identity: a fresh `{ state }` per run was a
// new-but-equal object on every recompute, so the gate never closed and every
// state()/loading()/error() reader — every CellView — re-ran on each commit of
// a ticking or streaming cell (Solid's UNSTABLE_MEMO_OUTPUT diagnostic, found
// 2026-10-16 under the RichTeX lab's trainer). Interned, a run that lands in
// the same state wakes no state reader. Only `errored` is minted per
// occurrence, because the error is its payload.
const frozenBox = (state: CellState): Box => Object.freeze({ state });
const BOX = Object.freeze({
  unresolved: frozenBox("unresolved"),
  pending: frozenBox("pending"),
  streaming: frozenBox("streaming"),
  refreshing: frozenBox("refreshing"),
  held: frozenBox("held"),
  ready: frozenBox("ready"),
}) satisfies Readonly<Record<Exclude<CellState, "errored">, Box>>;

/** The cell's equality gate as a predicate: identity by default, never-equal for `false`. */
function equalityOf<T>(equals: CellOptions<T>["equals"]): (prev: T, next: T) => boolean {
  if (equals === false) return () => false;
  return equals ?? ((prev, next) => prev === next);
}

export function cell<D, T>(
  deps: Accessor<D | undefined | null | false>,
  compute: CellCompute<D, T>,
  options?: CellOptions<T>,
): Cell<T> {
  const streamMode = options?.stream ?? "commit";
  // The effective identity: scope-qualified when built by a slice factory.
  const cellName =
    options?.name !== undefined
      ? options.scope !== undefined
        ? options.scope.qualify(options.name)
        : options.name
      : undefined;
  // ownedWrite: these are the cell's *internal* bookkeeping, legitimately
  // written from inside the compute's owned scope (the async wrappers run
  // their prologue synchronously inside the memo). Solid 2.0 dev mode
  // forbids owned-scope writes unless a signal opts in — beta.15 finding.
  const [progress, setProgress] = createSignal<number | undefined>(undefined, {
    ownedWrite: true,
  });
  const [settled, setSettled] = createSignal(true, { ownedWrite: true });
  const [partial, setPartial] = createSignal(false, { ownedWrite: true }); // any yield this run?
  // Boxed so `undefined` values are representable. Every publish is a fresh
  // box, so the signal's own identity gate always opens; the cell's `equals`
  // is applied BEFORE boxing, in publishLast.
  const [last, setLast] = createSignal<{ value: T } | undefined>(undefined, {
    ownedWrite: true,
  });
  // The last box handed to the signal — the side channel's comparison base.
  // A plain mirror, not a read of `last`: while a downstream consumer is
  // pending on this cell, in-flight writes stage into its transaction (the
  // stream:"latest" caveat on CellOptions), so the signal can lag what was
  // published by a whole run, and a comparison against it would let the two
  // channels disagree about what is new.
  let lastBox: { value: T } | undefined;
  const same = equalityOf(options?.equals);
  const publishLast = (value: T): void => {
    if (lastBox !== undefined && same(lastBox.value, value)) return; // equal ⇒ no one hears
    lastBox = { value };
    setLast(lastBox);
  };

  const memo = createMemo<T>(
    (prev) => {
      // Attribute this deps evaluation to the cell (dependency-edge capture —
      // graph-trace.ts). Only the deps read is bracketed: reads inside compute
      // are untracked by Solid and deliberately unattributed here too.
      const d = runAsConsumer(cellName, deps); // pending upstream throws NotReadyError: hold
      if (d === undefined || d === null || d === false) {
        throw new NotReadyError(null); // explicit hold — idiomatic 2.0 "not yet"
      }
      const ctrl = new AbortController();
      onCleanup(() => ctrl.abort()); // fires on supersede and on owner disposal
      const ctx: CellContext<T> = {
        signal: ctrl.signal,
        previous: prev,
        progress: (fraction) => {
          if (!ctrl.signal.aborted) setProgress(fraction);
        },
      };
      const out = compute(d, ctx);

      if (isAsyncIterable<T>(out)) {
        return streamMode === "commit" ? commitStream(out, ctx) : latestOnlyStream(out, ctx);
      }
      if (isThenable<T>(out)) {
        return trackPromise(out, ctx);
      }
      // Synchronous value: defer bookkeeping a microtask so we never write
      // signals inside the tracked scope.
      queueMicrotask(() => {
        if (!ctrl.signal.aborted) publishLast(out);
      });
      return out;
    },
    { equals: options?.equals },
  );

  function beginRun() {
    setSettled(false);
    setProgress(undefined);
    setPartial(false);
  }

  async function* commitStream(source: AsyncIterable<T>, ctx: CellContext<T>) {
    beginRun();
    let yielded = false;
    for await (const value of source) {
      if (ctx.signal.aborted) return; // superseded: framework finalizes us
      yielded = true;
      setPartial(true);
      publishLast(value);
      yield value; // committed to the graph; downstream recomputes
    }
    if (ctx.signal.aborted) return;
    if (!yielded) throw new Error("cell: async iterable finished without yielding");
    setSettled(true);
  }

  async function* latestOnlyStream(source: AsyncIterable<T>, ctx: CellContext<T>) {
    beginRun();
    let final: { value: T } | undefined;
    for await (const value of source) {
      if (ctx.signal.aborted) return;
      final = { value };
      setPartial(true);
      publishLast(value); // visible on latest(); not committed to the graph
    }
    if (ctx.signal.aborted) return;
    if (!final) throw new Error("cell: async iterable finished without yielding");
    setSettled(true);
    yield final.value; // the single graph commit for this run
  }

  async function* trackPromise(source: PromiseLike<T>, ctx: CellContext<T>) {
    beginRun();
    const value = await source; // rejections propagate to the error boundary
    if (ctx.signal.aborted) return;
    publishLast(value);
    setSettled(true);
    yield value;
  }

  /**
   * Why the gate needs three answers, not two: "gated" (deps returned
   * undefined/null/false — an explicit hold, nothing will run until the gate
   * opens) and "blocked" (deps threw NotReadyError — an upstream is computing
   * and a new value IS coming) look identical to the memo but mean opposite
   * things to a user. Conflating them was the old bug: a cancel button that
   * cleared the gate left the cell reading "refreshing" forever, and CellView
   * showed an indeterminate progress stripe over work that wasn't happening.
   */
  type Gate = "open" | "gated" | "blocked";
  const gateNow = (): Gate => {
    try {
      // Suspend edge attribution: this re-read serves state derivation, and it
      // can run while an OUTER cell's deps are being attributed (a deps that
      // reads inner.state()) — those reads are not the outer cell's edges.
      const d = runAsConsumer(undefined, deps);
      return d === undefined || d === null || d === false ? "gated" : "open";
    } catch (e) {
      if (e instanceof NotReadyError) return "blocked"; // upstream pending
      throw e;
    }
  };

  let resetError: (() => void) | undefined;
  const box = createErrorBoundary(
    (): Box => {
      try {
        memo(); // subscribe; between stream yields this succeeds
        // A re-gated cell can serve its stale value to tracked readers, so
        // check the gate before declaring ready.
        const gate = gateNow();
        if (gate === "gated") return BOX.held;
        if (gate === "blocked") return BOX.refreshing;
        return settled() ? BOX.ready : partial() ? BOX.streaming : BOX.refreshing;
      } catch (e) {
        if (e instanceof NotReadyError) {
          const hasValue = last() !== undefined;
          const gate = gateNow();
          if (gate === "gated") return hasValue ? BOX.held : BOX.unresolved;
          if (gate === "blocked" && !hasValue) return BOX.unresolved;
          if (partial()) return BOX.streaming; // latest-mode partials pre-commit
          return hasValue ? BOX.refreshing : BOX.pending;
        }
        throw e; // real errors go to the boundary fallback
      }
    },
    (err, reset) => {
      resetError = reset;
      return { state: "errored", error: err() } satisfies Box;
    },
  ) as Accessor<Box>;

  const read = (() => {
    if (cellName !== undefined) {
      recordRead({ kind: "cell", name: cellName }); // consumer-aware no-op otherwise
    }
    return memo();
  }) as Cell<T>;
  read.latest = () => {
    const boxed = last();
    if (boxed) return boxed.value;
    // Hold the invariant `state() === "ready"` ⟹ `latest() !== undefined`.
    // A *synchronous* compute returns straight out of the memo while its
    // publishLast is still queued a microtask behind it (see above), and `settled` starts
    // life `true` — so between those two points the cell reads "ready" with an
    // empty `last`. CellView renders its children on "ready" and hands them
    // `latest()` as an `Accessor<T>`; they dereference it. Serve the memo in
    // that window. Async computes never reach here with an empty `last`: their
    // wrappers setLast() before setSettled(true).
    //
    // Any throw means "no value yet" — a NotReadyError from a held upstream,
    // or a genuine compute error. Both are reported through state()/error(),
    // and latest() is contractually non-throwing.
    try {
      return memo();
    } catch {
      return undefined;
    }
  };
  read.state = () => box().state;
  read.error = () => box().error;
  read.loading = () => {
    const s = box().state;
    return s === "pending" || s === "streaming" || s === "refreshing";
  };
  read.progress = progress;
  read.settled = settled;
  read.refetch = () => {
    if (untrack(box).state === "errored" && resetError) resetError();
    else refresh(memo);
  };
  if (cellName !== undefined) {
    const name = cellName;
    read.cellName = name;
    read.loc = options?.loc;
    read.description = options?.description;
    registry.set(name, read as Cell<unknown>);
    if (getOwner()) {
      onCleanup(() => {
        if (registry.get(name) === (read as Cell<unknown>)) {
          registry.delete(name);
          dropConsumer(name); // its dependency edges die with it
        }
      });
    }
  }
  return read;
}

function isAsyncIterable<T>(x: unknown): x is AsyncIterable<T> {
  return x != null && typeof (x as AsyncIterable<T>)[Symbol.asyncIterator] === "function";
}

function isThenable<T>(x: unknown): x is PromiseLike<T> {
  return (
    x != null &&
    (typeof x === "object" || typeof x === "function") &&
    typeof (x as PromiseLike<T>).then === "function"
  );
}

/**
 * By default (stream: "commit"), downstream cells recompute on every yield.
 * Wrap a cell with `settledOnly` in a deps function to consume only completed
 * runs while keeping the stream visible elsewhere.
 */
export function settledOnly<T>(c: Cell<T>): T {
  const v = c();
  if (!c.settled()) throw new NotReadyError(null);
  return v;
}

/**
 * Cells need a reactive owner. Inside components you already have one; for a
 * module-scope graph (the typical "notebook" layout), wrap creation. Returns
 * the graph plus its disposer so an HMR handler can tear the old graph down.
 */
export function cellGraph<T>(setup: () => T): { graph: T; dispose: () => void } {
  let dispose!: () => void;
  const graph = createRoot((d) => {
    dispose = d;
    return setup();
  });
  return { graph, dispose };
}
