# solid-cells 2 — Observable-style async dataflow cells for SolidJS 2.0 (beta)

The SolidJS 2.0 port of solid-cells. Solid 2.0 rebuilt its reactive core around first-class async, and in doing so absorbed most of what the 1.x version of this library had to construct by hand. What remains is a thin layer (~200 lines) that turns raw async memos into *cells*: nodes with an `AbortSignal` per run, progress reporting, a non-throwing state machine for UI, last-known-value semantics across errors, deps gating, and a retry affordance — plus the same generic `CellView` and the cancellable Web Worker streaming protocol.

Everything below was type-checked with `tsc --noEmit` (strict) and the runtime semantics verified with the test harness in the appendix, against **solid-js 2.0.0-beta.15**, **@solidjs/web 2.0.0-beta.15**, **TypeScript 6.0.3**, **@observablehq/plot 0.6.17**, Node 22. The 2.0 line is a beta: APIs may still shift, and several behaviors documented here were established empirically rather than from documentation.

## What Solid 2.0 absorbed (verified empirically)

These 1.x-solid-cells responsibilities are now framework behavior, confirmed by probes against the beta:

**Async is first-class.** `createMemo` accepts computes returning promises *or async iterables*. Each `yield` of an async generator is committed to the graph and propagates to downstream computations and effects in real time — Observable's generator-cell semantics, natively. `isPending()` is false *between* yields; every partial is a first-class value.

**Downstream holds automatically.** Reading a memo that has no value yet throws `NotReadyError` through the reactive graph; reading one that is recomputing, from inside a tracked scope, does the same. A downstream computation that reads a pending upstream simply becomes pending itself and re-runs on settle. The 1.x `ready()` combinator is gone — you just read your inputs.

**Diamonds are transactionally consistent.** With `s → slow`, `s → fast`, and `pair = f(slow, fast)`, effects observing `pair` never see a mixed old/new commit after `s` changes. No topology bookkeeping needed.

**Stale values are kept.** While a new run is pending, the previous value is served (to untracked readers, and to the DOM, which simply doesn't update until the transaction settles). `<Loading>` is now for *initial* readiness only.

**Supersession is handled.** When sources change mid-flight, the stale run's eventual result is discarded, `onCleanup` registered inside the compute fires promptly (the AbortController hook), and a superseded async generator is finalized (its `finally` runs once its in-flight `await` settles).

**The previous value is an argument.** The compute receives the last committed value as its parameter — no `ctx.previous` plumbing needed at the framework level.

**Re-running is a primitive.** `refresh(memo)` invalidates and re-executes; error boundaries expose a `reset()` that re-runs the failed computation.

## What a cell still adds

`ctx.signal` — an `AbortSignal` aborted on supersession and disposal, wired via `onCleanup`, so fetches and workers actually stop rather than being merely ignored. `ctx.progress` — the framework has no progress notion. `settled()` — since every yield is a committed value and `isPending` is false between yields, "is the current run finished?" needs its own bookkeeping; this is what loading chrome actually wants. Non-throwing introspection — `state()`, `latest()`, `error()`: raw reads throw `NotReadyError` before the first value, and an errored memo reads as `undefined` *and loses its previous value*, so cells cache the last value produced by any run (surviving errors) and expose a six-state machine. Deps gating — `deps` returning `undefined`/`null`/`false` holds the cell (implemented as the idiomatic 2.0 "not yet": throwing `NotReadyError`). Streaming policy — `stream: "commit"` (default; per-yield graph commits) or `stream: "latest"` (1.x semantics: partials visible only on `latest()`/`progress()`, one graph commit on the final value — for expensive downstream work), plus `settledOnly()` to gate individual consumers on completed runs. Retry — `refetch()` routes to the error boundary's `reset()` when errored (re-runs with the same inputs), `refresh()` otherwise.

## Mapping to the Observable runtime

| Observable runtime | solid-cells 2 |
|---|---|
| `variable.define(name, inputs, fn)` | `const c = cell(deps, compute)` |
| A cell waits until all inputs fulfill | Reading a pending cell inside `deps` holds automatically; `deps` returning `undefined` holds explicitly |
| Recompute when any input changes | Any signal/cell read inside `deps` re-triggers `compute` |
| `invalidation` promise | `ctx.signal` (`AbortSignal`) |
| Generator cells: each yield re-runs dependents | Native: each yield commits and propagates (opt out per cell with `stream: "latest"`, or per consumer with `settledOnly`) |
| Pending / fulfilled / rejected states | `c.state()`: `unresolved · pending · streaming · refreshing · ready · errored` |
| Cell output area | `<CellView of={c}>{v => ...}</CellView>`, or idiomatic `<Loading>`/`<Errored>` |

## Semantics worth knowing (established by probe)

**Tracked vs untracked reads differ during a refresh.** Inside computations, reading a recomputing cell throws `NotReadyError` (that *is* the hold mechanism); at top level or in event handlers the stale value is served. `latest()` is the uniform "give me what you have" read.

**Errors need a boundary.** Without one, an errored memo reads as `undefined`, `isPending` reports `true` indefinitely, and the error is dumped to a global handler — a silent-ish failure. Each cell wraps its state derivation in `createErrorBoundary`, which also silences the global dump and provides `reset()`. The framework drops the memo's previous value on error, which is why `latest()` is backed by the cell's own cache.

**Writes are batched.** After `setX(1)`, a synchronous `x()` still returns the old value until `flush()` (or the microtask boundary). Reactive code doesn't notice; imperative test-style code must `flush()` or `await resolve(...)`.

**A re-held cell reads as `refreshing`.** If `deps` returns `undefined` after a value has settled, the cell keeps serving its stale value and reports `refreshing` — downstream holds, UI keeps the last render with a stripe. `unresolved` is reserved for never-had-a-value.

## Files

```
src/
  cell.ts           the primitive: cell(), settledOnly(), cellGraph()
  cell-view.tsx     <CellView> — loading/streaming/error/stale wrapper
  worker-stream.ts  cancellable request/stream protocol for Web Workers + fromWorker()
  mc.worker.ts      demo worker: streaming Monte Carlo GBM band
  App.tsx           demo: sliders → worker cell → Observable Plot, both stream policies
```

## src/cell.ts

```ts
/**
 * cell.ts — Observable-style async dataflow cells for SolidJS 2.0 (beta).
 *
 * Solid 2.0 made async first-class: memos accept promises and async
 * iterables, the graph suspends/resumes consumers, commits are transactional
 * (no glitch diamonds), stale values are served while new work is pending,
 * superseded runs are discarded and their `onCleanup`s fire. That is most of
 * what solid-cells 1.x had to build by hand.
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
 *     Reading a pending memo throws NotReadyError before its first value,
 *     and an errored memo reads as `undefined` — fine for the graph,
 *     useless for a status line. Cells keep the last good value across
 *     errors and expose a five-plus-one state machine.
 *   - deps gating: `deps` returning undefined/null/false holds the cell
 *     (internally: throw NotReadyError, the idiomatic 2.0 "not yet").
 *   - Retry: `refetch()` uses the error boundary's reset when errored,
 *     `refresh()` otherwise.
 *
 * What is gone from 1.x: `ready()`. Reading another cell inside `deps` (or
 * inside `compute` via a memo) propagates NotReadyError, so downstream cells
 * hold on pending upstreams automatically, with transactional consistency
 * across diamonds. Just read your inputs.
 */
import {
  createErrorBoundary,
  createMemo,
  createRoot,
  createSignal,
  onCleanup,
  refresh,
  untrack,
  NotReadyError,
  type Accessor,
} from "solid-js";

export type CellState =
  | "unresolved" // never had a value; deps are held
  | "pending"    // never had a value; first run in flight
  | "streaming"  // has a value; current run still yielding
  | "refreshing" // has a value; newer run pending, or deps re-held
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

export type CellCompute<D, T> = (
  deps: D,
  ctx: CellContext<T>,
) => T | Promise<T> | AsyncIterable<T>;

export interface CellOptions {
  /**
   * How async-iterable computes stream:
   * - "commit" (default): every yield is committed to the graph — downstream
   *   cells recompute per partial (Observable generator semantics, native to
   *   Solid 2.0).
   * - "latest": partials are visible only on `latest()`/`progress()`; the
   *   graph commits once, on the final value (solid-cells 1.x semantics).
   *   Use when downstream work is expensive.
   */
  stream?: "commit" | "latest";
}

export interface Cell<T> {
  /**
   * The reactive read. Inside tracked scopes (other cells' deps, memos,
   * effects, JSX) it throws NotReadyError before the first value and while a
   * newer run is pending — which is precisely how downstream consumers hold
   * and stay glitch-free. Untracked/top-level reads serve the last committed
   * value during a refresh. For UI that should keep rendering the previous
   * value, read latest() instead.
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
}

/**
 * Create a cell.
 *
 * `deps` is a synchronous tracked function. Returning undefined/null/false
 * holds the cell. Reading another cell (or any pending async memo) inside
 * `deps` holds this cell too — that is the 2.0 replacement for 1.x `ready()`.
 *
 * `compute` may return a plain value, a promise, or an async iterable. Must
 * be called under a reactive owner (a component, or `cellGraph` at module
 * scope).
 */
export function cell<D, T>(
  deps: Accessor<D | undefined | null | false>,
  compute: CellCompute<D, T>,
  options?: CellOptions,
): Cell<T> {
  const streamMode = options?.stream ?? "commit";
  const [progress, setProgress] = createSignal<number | undefined>(undefined);
  const [settled, setSettled] = createSignal(true);
  const [partial, setPartial] = createSignal(false); // any yield this run?
  // Boxed so `undefined` values are representable; equals:false so re-yields
  // of an in-place-mutated object still notify.
  const [last, setLast] = createSignal<{ value: T } | undefined>(undefined, {
    equals: false,
  });

  const memo = createMemo<T>((prev) => {
    const d = deps(); // reading a pending upstream throws NotReadyError: hold
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
      return streamMode === "commit"
        ? commitStream(out, ctx)
        : latestOnlyStream(out, ctx);
    }
    if (isThenable<T>(out)) {
      return trackPromise(out, ctx);
    }
    // Synchronous value: defer bookkeeping a microtask so we never write
    // signals inside the tracked scope.
    queueMicrotask(() => {
      if (!ctrl.signal.aborted) setLast({ value: out });
    });
    return out;
  });

  // --- run wrappers (async bodies: signal writes here are ordinary external
  // writes, observed by effects in real time) -------------------------------

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
      setLast({ value });
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
      setLast(final); // visible on latest(); not committed to the graph
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
    setLast({ value });
    setSettled(true);
    yield value;
  }

  // --- state machine, error capture, retry ---------------------------------

  const heldNow = (): boolean => {
    try {
      const d = deps();
      return d === undefined || d === null || d === false;
    } catch (e) {
      if (e instanceof NotReadyError) return true; // upstream held/pending
      throw e;
    }
  };

  type Box = { state: CellState; error?: unknown };
  let resetError: (() => void) | undefined;
  const box = createErrorBoundary(
    (): Box => {
      try {
        memo(); // subscribe; between stream yields this succeeds
        // A re-held cell can serve its stale value to tracked readers, so
        // check the gate before declaring ready.
        if (heldNow()) return { state: "refreshing" };
        return { state: settled() ? "ready" : partial() ? "streaming" : "refreshing" };
      } catch (e) {
        if (e instanceof NotReadyError) {
          // Tracked reads throw NotReady both before the first value and
          // while a newer run is pending — that is exactly how downstream
          // cells hold. Disambiguate with our own bookkeeping:
          const hasValue = last() !== undefined;
          if (heldNow()) return { state: hasValue ? "refreshing" : "unresolved" };
          if (partial()) return { state: "streaming" }; // latest-mode partials pre-commit
          return { state: hasValue ? "refreshing" : "pending" };
        }
        throw e; // real errors go to the boundary fallback
      }
    },
    (err, reset) => {
      resetError = reset;
      return { state: "errored", error: err() } satisfies Box;
    },
  ) as Accessor<Box>;

  const read = (() => memo()) as Cell<T>;
  read.latest = () => last()?.value;
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
  return read;
}

function isAsyncIterable<T>(x: unknown): x is AsyncIterable<T> {
  return (
    x != null &&
    typeof (x as AsyncIterable<T>)[Symbol.asyncIterator] === "function"
  );
}

function isThenable<T>(x: unknown): x is PromiseLike<T> {
  return (
    x != null &&
    (typeof x === "object" || typeof x === "function") &&
    typeof (x as PromiseLike<T>).then === "function"
  );
}

// ---------------------------------------------------------------------------
// settledOnly(): gate downstream on run completion
// ---------------------------------------------------------------------------

/**
 * By default (stream: "commit"), downstream cells recompute on every yield.
 * Wrap a cell with `settledOnly` in a deps function to consume only completed
 * runs while keeping the stream visible elsewhere:
 *
 *   const report = cell(() => settledOnly(band), b => buildReport(b));
 */
export function settledOnly<T>(c: Cell<T>): T {
  const v = c();
  if (!c.settled()) throw new NotReadyError(null);
  return v;
}

// ---------------------------------------------------------------------------
// cellGraph(): app-lifetime graphs at module scope
// ---------------------------------------------------------------------------

/**
 * Cells need a reactive owner. Inside components you already have one; for a
 * module-scope graph (the typical "notebook" layout), wrap creation:
 *
 *   export const g = cellGraph(() => {
 *     const prices = cell(...);
 *     const fit = cell(() => ({ px: prices() }), ...);
 *     return { prices, fit };
 *   });
 */
export function cellGraph<T>(setup: () => T): T {
  return createRoot(() => setup());
}
```

## src/cell-view.tsx

```tsx
/**
 * cell-view.tsx — one generic wrapper that gives every visualization the
 * notebook feel: spinner + progress before the first value, error box with
 * retry, and keep-the-last-render (dimmed, progress stripe) while a new run
 * streams or refreshes.
 *
 * Note: with Solid 2.0 you can also go fully idiomatic — read the cell
 * directly under <Loading fallback={...}> and <Errored fallback={...}>, with
 * isPending()/cell.settled() driving an inline indicator. CellView packages
 * that pattern (via the cell's own state machine) so charts don't repeat it.
 */
import { Match, Show, Switch, type Accessor } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { Cell } from "./cell";

export function CellView<T>(props: {
  of: Cell<T>;
  children: (value: Accessor<T>) => JSX.Element;
  /** Shown before the first value (default: spinner + progress). */
  fallback?: JSX.Element;
  /** Shown on error (default: message + retry button). */
  errorFallback?: (error: unknown, retry: () => void) => JSX.Element;
  /** Keep showing the last value, dimmed, while recomputing. Default true. */
  keepLatest?: boolean;
  /** Label for the default pending state. */
  label?: string;
}): JSX.Element {
  const showValue = () => {
    const s = props.of.state();
    if (s === "ready") return true;
    if (s === "errored" || s === "unresolved" || s === "pending") return false;
    // streaming/refreshing: show the last value (a streamed partial counts)
    return props.keepLatest !== false && props.of.latest() !== undefined;
  };

  return (
    <Switch
      fallback={
        props.fallback ?? (
          <DefaultPending label={props.label} progress={props.of.progress()} />
        )
      }
    >
      <Match when={props.of.state() === "errored"}>
        {props.errorFallback ? (
          props.errorFallback(props.of.error(), props.of.refetch)
        ) : (
          <DefaultError error={props.of.error()} retry={props.of.refetch} />
        )}
      </Match>
      <Match when={showValue()}>
        <div style={{ position: "relative" }}>
          <div
            style={{
              opacity: props.of.loading() ? 0.45 : 1,
              transition: "opacity 150ms ease",
            }}
          >
            {props.children(() => props.of.latest() as T)}
          </div>
          <Show when={props.of.loading()}>
            <ProgressStripe value={props.of.progress()} />
          </Show>
        </div>
      </Match>
    </Switch>
  );
}

// --- default chrome (no CSS files needed; animation is SMIL) ---------------

export function Spinner(props: { size?: number }) {
  const s = () => props.size ?? 16;
  return (
    <svg width={s()} height={s()} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-opacity="0.2" stroke-width="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" stroke-width="3" stroke-linecap="round">
        <animateTransform
          attributeName="transform"
          type="rotate"
          from="0 12 12"
          to="360 12 12"
          dur="0.9s"
          repeatCount="indefinite"
        />
      </path>
    </svg>
  );
}

function DefaultPending(props: { label?: string; progress?: number }) {
  return (
    <div
      style={{
        display: "flex",
        "align-items": "center",
        gap: "10px",
        padding: "14px 4px",
        color: "#6b7280",
        "font-size": "13px",
      }}
    >
      <Spinner />
      <span>
        {props.label ?? "computing"}
        {props.progress !== undefined
          ? ` · ${Math.round(props.progress * 100)}%`
          : "…"}
      </span>
    </div>
  );
}

function DefaultError(props: { error: unknown; retry: () => void }) {
  const message = () => {
    const e = props.error as { message?: string } | undefined;
    return String(e?.message ?? props.error);
  };
  return (
    <div
      style={{
        display: "flex",
        "align-items": "center",
        gap: "12px",
        border: "1px solid #e0b4b4",
        background: "#fbf5f5",
        color: "#8a3434",
        padding: "10px 12px",
        "border-radius": "6px",
        "font-size": "13px",
      }}
    >
      <span style={{ flex: "1" }}>{message()}</span>
      <button
        onClick={() => props.retry()}
        style={{
          border: "1px solid currentColor",
          background: "transparent",
          color: "inherit",
          "border-radius": "4px",
          padding: "3px 10px",
          cursor: "pointer",
          font: "inherit",
        }}
      >
        Retry
      </button>
    </div>
  );
}

function ProgressStripe(props: { value?: number }) {
  return (
    <div
      style={{
        position: "absolute",
        top: "0",
        left: "0",
        right: "0",
        height: "3px",
        background: "rgba(0,0,0,0.07)",
        "border-radius": "2px",
        overflow: "hidden",
      }}
    >
      <Show
        when={props.value !== undefined}
        fallback={
          <svg width="100%" height="3" viewBox="0 0 100 3" preserveAspectRatio="none">
            <rect y="0" width="30" height="3" fill="#4f7cac">
              <animate attributeName="x" values="-30;100" dur="1.1s" repeatCount="indefinite" />
            </rect>
          </svg>
        }
      >
        <div
          style={{
            width: `${(props.value ?? 0) * 100}%`,
            height: "100%",
            background: "#4f7cac",
            transition: "width 200ms ease",
          }}
        />
      </Show>
    </div>
  );
}
```

## src/worker-stream.ts

```ts
/**
 * worker-stream.ts — dependency-free request/stream protocol for Web Workers.
 *
 * `workerStream()` returns an async generator, so a cell can consume a worker
 * directly:
 *
 *   const band = cell(
 *     () => params(),
 *     (p, ctx) => workerStream<Params, Band>(worker, p, ctx),
 *   );
 *
 * Partials stream into the cell, progress messages drive ctx.progress, and
 * aborting the cell posts a "cancel" message so the worker actually stops
 * computing. Under Solid 2.0, a superseded run's generator is also finalized
 * by the framework (its finally runs), which detaches the listeners here.
 */

export type WorkerRun<TIn> = { id: number; type: "run"; payload: TIn };
export type WorkerCancel = { id: number; type: "cancel" };
export type WorkerRequest<TIn> = WorkerRun<TIn> | WorkerCancel;

export type WorkerReply<TOut> =
  | { id: number; type: "partial"; value: TOut }
  | { id: number; type: "progress"; value: number }
  | { id: number; type: "done"; value: TOut }
  | { id: number; type: "error"; message: string };

let nextId = 1;

/**
 * Typed compute factory: the ergonomic way to point a cell at a worker.
 *
 *   const band = cell(params, fromWorker<Params, Band>(worker));
 *
 * Because the returned function is fully annotated, TypeScript infers the
 * cell's value type without help. (Writing the lambda inline —
 * `(p, ctx) => workerStream<In, Out>(w, p, ctx)` — defeats inference: an
 * untyped `ctx` makes the callback context-sensitive, which pins T to
 * `unknown` before the return type is considered. If you do write it inline,
 * annotate: `(p, ctx: CellContext<Band>) => ...`.)
 */
export function fromWorker<TIn, TOut>(worker: Worker) {
  return (
    payload: TIn,
    ctx: { signal: AbortSignal; progress?: (fraction: number) => void },
  ): AsyncGenerator<TOut, void, void> =>
    workerStream<TIn, TOut>(worker, payload, ctx);
}

export async function* workerStream<TIn, TOut>(
  worker: Worker,
  payload: TIn,
  ctx: { signal: AbortSignal; progress?: (fraction: number) => void },
): AsyncGenerator<TOut, void, void> {
  const id = nextId++;
  const queue: TOut[] = [];
  let done = false;
  let failure: unknown;
  let final: TOut | undefined;
  let hasFinal = false;

  let wake = () => {};
  let gate = new Promise<void>((resolve) => (wake = resolve));
  const bump = () => {
    const w = wake;
    gate = new Promise<void>((resolve) => (wake = resolve));
    w();
  };

  const onMessage = (event: MessageEvent<WorkerReply<TOut>>) => {
    const msg = event.data;
    if (!msg || msg.id !== id) return;
    switch (msg.type) {
      case "progress":
        ctx.progress?.(msg.value);
        return;
      case "partial":
        queue.push(msg.value);
        bump();
        return;
      case "done":
        final = msg.value;
        hasFinal = true;
        done = true;
        bump();
        return;
      case "error":
        failure = new Error(msg.message);
        done = true;
        bump();
        return;
    }
  };

  const onAbort = () => {
    worker.postMessage({ id, type: "cancel" } satisfies WorkerCancel);
    failure = ctx.signal.reason ?? new DOMException("Aborted", "AbortError");
    done = true;
    bump();
  };

  worker.addEventListener("message", onMessage);
  ctx.signal.addEventListener("abort", onAbort, { once: true });
  try {
    if (ctx.signal.aborted) {
      throw ctx.signal.reason ?? new DOMException("Aborted", "AbortError");
    }
    worker.postMessage({ id, type: "run", payload } satisfies WorkerRun<TIn>);
    for (;;) {
      // Capture the gate *before* checking the queue: if a message lands
      // between the check and the await, the captured promise has already
      // been resolved and we won't stall on the freshly created one.
      const g = gate;
      if (queue.length > 0) {
        yield queue.shift()!;
        continue;
      }
      if (done) break;
      await g;
    }
    if (failure) throw failure;
    if (hasFinal) yield final as TOut;
  } finally {
    worker.removeEventListener("message", onMessage);
    ctx.signal.removeEventListener("abort", onAbort);
  }
}
```

## src/mc.worker.ts

```ts
/**
 * mc.worker.ts — demo heavy computation: Monte Carlo GBM price paths,
 * accumulating a mean ± 2σ band over one trading year. Streams a partial
 * band every CHUNK paths, reports progress, and honors cancellation.
 *
 * Note on typing: in a real Vite project, give worker files their own
 * tsconfig with `"lib": ["ES2022", "WebWorker"]`. To keep this demo on a
 * single tsconfig (which includes the DOM lib), we cast `self` to the small
 * surface we use.
 */
import type { WorkerReply, WorkerRequest } from "./worker-stream";

export type McParams = {
  nPaths: number;
  nSteps: number;
  s0: number;
  mu: number;
  sigma: number;
};

export type McBand = {
  nPaths: number; // paths accumulated so far
  steps: number[];
  mean: number[];
  lo: number[]; // mean - 2 sd
  hi: number[]; // mean + 2 sd
};

const scope = self as unknown as {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage: (message: unknown) => void;
};

const cancelled = new Set<number>();
const post = (message: WorkerReply<McBand>) => scope.postMessage(message);

scope.onmessage = async (event: MessageEvent) => {
  const msg = event.data as WorkerRequest<McParams>;
  if (msg.type === "cancel") {
    cancelled.add(msg.id);
    return;
  }
  if (msg.type !== "run") return;

  const { id, payload } = msg;
  const { nPaths, nSteps, s0, mu, sigma } = payload;
  const dt = 1 / 252;
  const drift = (mu - 0.5 * sigma * sigma) * dt;
  const vol = sigma * Math.sqrt(dt);
  const sum = new Float64Array(nSteps + 1);
  const sumSq = new Float64Array(nSteps + 1);
  const CHUNK = 2000;

  try {
    for (let i = 0; i < nPaths; i++) {
      let s = s0;
      sum[0] += s;
      sumSq[0] += s * s;
      for (let t = 1; t <= nSteps; t++) {
        s *= Math.exp(drift + vol * gaussian());
        sum[t] += s;
        sumSq[t] += s * s;
      }
      const doneCount = i + 1;
      if (doneCount % CHUNK === 0 || doneCount === nPaths) {
        // Yield to the event loop so "cancel" messages can be delivered —
        // a microtask is not enough, message events are macrotasks.
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (cancelled.has(id)) {
          cancelled.delete(id);
          return;
        }
        post({ id, type: "progress", value: doneCount / nPaths });
        post({
          id,
          type: doneCount === nPaths ? "done" : "partial",
          value: band(doneCount, sum, sumSq),
        });
      }
    }
  } catch (err) {
    post({
      id,
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    });
  }
};

function band(n: number, sum: Float64Array, sumSq: Float64Array): McBand {
  const len = sum.length;
  const steps = new Array<number>(len);
  const mean = new Array<number>(len);
  const lo = new Array<number>(len);
  const hi = new Array<number>(len);
  for (let t = 0; t < len; t++) {
    const m = sum[t] / n;
    const sd = Math.sqrt(Math.max(sumSq[t] / n - m * m, 0));
    steps[t] = t;
    mean[t] = m;
    lo[t] = m - 2 * sd;
    hi[t] = m + 2 * sd;
  }
  return { nPaths: n, steps, mean, lo, hi };
}

// Marsaglia polar method
let spare: number | null = null;
function gaussian(): number {
  if (spare !== null) {
    const v = spare;
    spare = null;
    return v;
  }
  let u = 0;
  let v = 0;
  let s = 0;
  do {
    u = Math.random() * 2 - 1;
    v = Math.random() * 2 - 1;
    s = u * u + v * v;
  } while (s === 0 || s >= 1);
  const mul = Math.sqrt((-2 * Math.log(s)) / s);
  spare = v * mul;
  return u * mul;
}
```

## src/App.tsx

```tsx
/**
 * App.tsx — demo: a module-scope cell graph driving Observable Plot on
 * Solid 2.0.
 *
 * Drag a slider → the in-flight worker run is cancelled, a new one starts,
 * the previous chart stays visible (dimmed, progress stripe), and the band
 * streams in. Two derivations show both streaming policies:
 *   - `summary` reads `band()` directly → recomputes on every yield (live).
 *   - `report` reads `settledOnly(band)` → recomputes only on completed runs.
 */
import { createEffect, createSignal } from "solid-js";
import type { JSX } from "@solidjs/web";
import { render } from "@solidjs/web";
import * as Plot from "@observablehq/plot";
import { cell, cellGraph, settledOnly } from "./cell";
import { CellView } from "./cell-view";
import { fromWorker } from "./worker-stream";
import type { McBand, McParams } from "./mc.worker";

const worker = new Worker(new URL("./mc.worker.ts", import.meta.url), {
  type: "module",
});

// --- parameters (plain signals) --------------------------------------------

const [mu, setMu] = createSignal(0.06);
const [sigma, setSigma] = createSignal(0.2);
const [nPaths, setNPaths] = createSignal(100_000);

// --- the dataflow graph (module scope, notebook-style) ---------------------

const g = cellGraph(() => {
  const band = cell(
    () =>
      ({
        nPaths: nPaths(),
        nSteps: 252,
        s0: 100,
        mu: mu(),
        sigma: sigma(),
      }) satisfies McParams,
    fromWorker<McParams, McBand>(worker),
  );

  // Streams: recomputes on every partial band the worker posts.
  const summary = cell(
    () => ({ b: band() }),
    ({ b }) => {
      const last = b.mean.length - 1;
      return {
        simulated: b.nPaths,
        terminalMean: b.mean[last],
        terminalLo: b.lo[last],
        terminalHi: b.hi[last],
      };
    },
  );

  // Settled-only: recomputes once per completed run.
  const report = cell(
    () => ({ b: settledOnly(band) }),
    ({ b }) => `final: ${b.nPaths.toLocaleString()} paths accumulated`,
  );

  return { band, summary, report };
});

// --- Observable Plot bridge -------------------------------------------------

function PlotFigure(props: { options: Plot.PlotOptions }) {
  let host!: HTMLDivElement;
  createEffect(
    () => props.options,
    (options) => {
      const figure = Plot.plot(options);
      host.replaceChildren(figure);
      return () => figure.remove();
    },
  );
  return <div ref={host} />;
}

function fanOptions(b: McBand): Plot.PlotOptions {
  const rows = b.steps.map((t, i) => ({
    t,
    mean: b.mean[i],
    lo: b.lo[i],
    hi: b.hi[i],
  }));
  return {
    height: 280,
    x: { label: "trading day" },
    y: { label: "price", grid: true },
    marks: [
      Plot.areaY(rows, { x: "t", y1: "lo", y2: "hi", fill: "#4f7cac", fillOpacity: 0.15 }),
      Plot.lineY(rows, { x: "t", y: "mean", stroke: "#4f7cac" }),
    ],
  };
}

// --- UI ---------------------------------------------------------------------

function Param(props: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onInput: (v: number) => void;
}): JSX.Element {
  return (
    <label style={{ display: "flex", "flex-direction": "column", gap: "4px", "font-size": "12px", color: "#374151" }}>
      {props.label}
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onInput={(e) => props.onInput(e.currentTarget.valueAsNumber)}
      />
    </label>
  );
}

function App() {
  return (
    <main style={{ "max-width": "720px", margin: "2rem auto", "font-family": "system-ui, sans-serif" }}>
      <h1 style={{ "font-size": "17px" }}>Monte Carlo GBM — streaming cell demo (Solid 2.0)</h1>

      <div style={{ display: "flex", gap: "20px", margin: "12px 0 20px" }}>
        <Param label={`drift μ = ${mu().toFixed(2)}`} min={-0.2} max={0.3} step={0.01} value={mu()} onInput={setMu} />
        <Param label={`vol σ = ${sigma().toFixed(2)}`} min={0.05} max={0.6} step={0.01} value={sigma()} onInput={setSigma} />
        <Param label={`paths = ${nPaths().toLocaleString()}`} min={20_000} max={500_000} step={20_000} value={nPaths()} onInput={setNPaths} />
      </div>

      <CellView of={g.band} label="simulating">
        {(b) => <PlotFigure options={fanOptions(b())} />}
      </CellView>

      <CellView of={g.summary}>
        {(s) => (
          <p style={{ color: "#374151", "font-size": "13px" }}>
            {s().simulated.toLocaleString()} paths · terminal mean {s().terminalMean.toFixed(2)} · ±2σ [
            {s().terminalLo.toFixed(2)}, {s().terminalHi.toFixed(2)}]
          </p>
        )}
      </CellView>

      <CellView of={g.report}>
        {(r) => <p style={{ color: "#9ca3af", "font-size": "12px" }}>{r()}</p>}
      </CellView>
    </main>
  );
}

render(() => <App />, document.getElementById("root")!);
```

## Project scaffold

The 2.0 packages live under the `next` dist-tag, and the web runtime is its own package now:

```bash
npm create vite@latest my-app -- --template solid-ts
cd my-app
npm i solid-js@next @solidjs/web@next @observablehq/plot
npm i -D vite-plugin-solid@next        # 3.0.0-next.5 at time of writing
```

Two renames to make in a fresh scaffold: `render` is imported from `@solidjs/web` (not `solid-js/web`), and the JSX runtime moved with it. The code above type-checks under:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "jsx": "preserve",
    "jsxImportSource": "@solidjs/web",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true
  },
  "include": ["src"]
}
```

The `JSX` type is also imported from `@solidjs/web`. As in the 1.x version, give worker files their own tsconfig with `"lib": ["ES2022", "WebWorker"]` in a real project and drop the `self` cast in `mc.worker.ts`.

## Usage patterns

**A plain fetch cell.** Unchanged in spirit; note that upstream cells are read directly in `deps` — no `ready()`:

```ts
const prices = cell(
  () => {
    const s = symbol();                                 // plain signal
    return s ? { symbol: s, days: lookback() } : undefined;  // undefined = hold
  },
  async ({ symbol, days }, ctx) => {
    const res = await fetch(`/api/prices/${symbol}?days=${days}`, { signal: ctx.signal });
    if (!res.ok) throw new Error(`prices: ${res.status}`);
    return (await res.json()) as PricePoint[];
  },
);

// reading prices() here holds `fit` until prices has a value — automatically
const fit = cell(() => ({ px: prices(), l: lambda() }), ({ px, l }, ctx) =>
  fitModel(px, l, ctx.signal),
);
```

**Warm starts.** `ctx.previous` is the last committed value (the framework passes it into the compute):

```ts
const weights = cell(() => ({ s: signals(), g: gamma() }), ({ s, g }, ctx) =>
  solvePortfolio(s, g, { init: ctx.previous, signal: ctx.signal }),
);
```

**Choosing a stream policy.** Default `"commit"` makes every worker partial flow through the graph — cheap derivations (summary stats, chart data) update live. For expensive derivations, either create the producing cell with `{ stream: "latest" }` (nothing downstream sees partials) or leave it streaming and gate individual consumers with `settledOnly(band)` in their deps — the demo App shows both.

**Idiomatic 2.0, without CellView.** Cells compose with the built-in boundaries because the raw read throws `NotReadyError` like any async memo:

```tsx
<Errored fallback={(e, reset) => <ErrorBox err={e()} retry={reset} />}>
  <Loading fallback={<Skeleton />}>
    <PlotFigure options={fanOptions(band())} />
  </Loading>
</Errored>
```

`<Loading>` only guards initial readiness; subsequent refreshes keep the previous DOM automatically. `CellView` exists to package the streaming/refreshing affordances (dim + progress stripe + retry) that the boundaries don't provide.

**Module-scope graphs** via `cellGraph(...)` are unchanged. **Caching/dedup** remains out of scope — feed TanStack Solid Query results in as accessors.

## Migrating from solid-cells 1.x

`ready(a, b)` → delete it; read `a()` and `b()` directly in `deps`. `ctx.emit` → gone; yield from an async generator instead (partials are now first-class). Partials re-triggering downstream is now the *default*; recover 1.x behavior with `{ stream: "latest" }` or `settledOnly`. `state()` gains a `streaming` value. `refetch()` now also recovers from errors (boundary reset). `CellView` props are unchanged.

## TypeScript inference notes

Same shape as 1.x, re-verified on the beta: `T` infers from the compute's return for plain values, promises, and inline async generators — *unless* the lambda both leaves `ctx` unannotated and references it, which pins `T` to `unknown` (context-sensitive callback; `ctx: CellContext<T>` fixes `T` before the return type is inferred). Escape hatches, in order: the `fromWorker<In, Out>(worker)` factory, or annotate the parameter (`ctx: CellContext<Out>`). Requires TS ≥ 5.0; verified on TS 6.

## Caveats

- This targets a **beta**. The probe-established behaviors (tracked-read throw during refresh, error-boundary interplay, per-yield commit timing) are exactly the kind of thing that can shift before 2.0 final; the appendix test suite is the fastest way to re-validate against a newer beta.
- `undefined`/`null`/`false` from `deps` means hold. A cell may still *resolve* to `undefined`, but `CellView`'s keep-stale check treats `latest() === undefined` as "nothing to show" — wrap optional results.
- If a run errors mid-stream, `state()` is `"errored"` while `latest()` keeps the last partial. Check `error()`, don't infer health from the presence of a value.
- Synchronous computes defer their `latest()` bookkeeping by one microtask (to avoid writes inside the tracked scope); the graph value itself is immediate.
- Deps re-run the cell on any tracked change regardless of deep equality; memoize inside `deps` with `createMemo(..., { equals })` if you need equality cuts.
- In imperative code (tests, handlers doing read-after-write), remember the batched-write model: `flush()` or `await resolve(fn)` before reading.
- For module-scope graphs under Vite HMR, dispose and rebuild on `import.meta.hot` or move the graph into a context provider if reload leaks matter during development.

## Appendix: verified behavior

All assertions pass under Node 22 against the browser build. They double as an executable spec: holds (unresolved) while deps are undefined; no value before the first run; pending after deps arrive; resolves to the computed value; downstream computes from upstream via direct read; latest() keeps the prior value during refresh; chains settle; downstream commits only consistent values; diamond commits are transactionally consistent; superseded runs are aborted (2 aborts on 2 rapid flips, stale results discarded); streaming state with the first partial; generators settle with the last yield; downstream recomputes per yield; progress is observed live by effects; settledOnly consumers see only final values; latest-mode partials are visible on latest() while committing only the final value downstream; a superseded latest-mode run is discarded cleanly (no unowned rejection); async errors surface as errored state with error() exposed while latest() keeps the last good value; recovery on deps change; refetch() re-runs after an error via boundary reset; refetch re-runs healthy cells; worker partials are visible mid-run; a deps change posts exactly one cancel to the worker; a synchronous burst of worker partials reaches a slow consumer in order; fromWorker cells settle; a re-held cell keeps its stale value and reads as refreshing; root disposal aborts in-flight runs.

To re-run: put the test below at `test/test.ts`, compile with a CommonJS tsconfig (`"module": "CommonJS"`, `"moduleResolution": "node10"`, `"ignoreDeprecations": "6.0"`, include `src/cell.ts`, `src/worker-stream.ts`, `test/test.ts`, `"outDir": "dist-test"`), then run **`node --conditions browser dist-test/test/test.js`** — the flag selects the reactive browser build; the harness detects and refuses the non-reactive server build.

```ts
import {
  createEffect,
  createRoot,
  createSignal,
  flush,
  getOwner,
  runWithOwner,
} from "solid-js";
import { cell, cellGraph, settledOnly, type CellContext } from "../src/cell";
import { workerStream, fromWorker } from "../src/worker-stream";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
let failures = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log("ok   -", msg);
  else {
    failures++;
    console.error("FAIL -", msg);
  }
}

// --- fake worker over EventTarget (same message protocol) -------------------
type FakePayload = { values: number[]; delay: number; burst?: boolean };

class FakeWorker extends EventTarget {
  cancelled = new Set<number>();
  received: unknown[] = [];
  postMessage(msg: any) {
    this.received.push(msg);
    if (msg.type === "cancel") {
      this.cancelled.add(msg.id);
      return;
    }
    if (msg.type !== "run") return;
    const { id } = msg;
    const payload = msg.payload as FakePayload;
    const send = (data: unknown) =>
      this.dispatchEvent(new MessageEvent("message", { data }));
    void (async () => {
      if (payload.burst) {
        for (const v of payload.values.slice(0, -1))
          send({ id, type: "partial", value: v });
        send({ id, type: "done", value: payload.values[payload.values.length - 1] });
        return;
      }
      let i = 0;
      for (const v of payload.values) {
        await sleep(payload.delay);
        if (this.cancelled.has(id)) return;
        i++;
        send({ id, type: "progress", value: i / payload.values.length });
        send({
          id,
          type: i === payload.values.length ? "done" : "partial",
          value: v,
        });
      }
    })();
  }
}

async function main() {
  // sanity: reactive build?
  let effectRuns = 0;
  let bump = () => {};
  createRoot(() => {
    const [x, setX] = createSignal(0);
    bump = () => setX((v) => v + 1);
    createEffect(x, () => void effectRuns++);
  });
  flush();
  bump();
  flush();
  await sleep(0);
  if (effectRuns < 2) {
    throw new Error(
      "solid-js resolved to a non-reactive build; run with --conditions browser",
    );
  }

  await createRoot(async (dispose) => {
    const owner = getOwner();
    const mk = <T,>(fn: () => T): T => runWithOwner(owner, fn) as T;

    // 1. deps gating: unresolved until deps arrive, pending during first run
    let aRuns = 0;
    const [go, setGo] = createSignal<number | undefined>(undefined);
    const a = mk(() =>
      cell(go, async (n) => {
        aRuns++;
        await sleep(20);
        return n * 2;
      }),
    );
    flush();
    await sleep(30);
    assert(aRuns === 0 && a.state() === "unresolved", "holds (unresolved) while deps are undefined");
    assert(a.latest() === undefined, "no value before first run");

    setGo(21);
    flush();
    assert(a.state() === "pending" && a.loading(), "pending after deps arrive, before first value");
    await sleep(40);
    flush();
    assert(a.latest() === 42 && a.state() === "ready", "resolves to computed value");

    // 2. chaining by direct read (ready() replacement)
    const b = mk(() =>
      cell(
        () => ({ av: a() }),
        async ({ av }) => {
          await sleep(10);
          return av + 1;
        },
      ),
    );
    flush();
    await sleep(30);
    assert(b.latest() === 43, "downstream computes from upstream value via direct read");

    // 3. keep-stale + auto-hold: upstream refresh gates downstream, no glitches
    const bCommits: number[] = [];
    mk(() => createEffect(() => b(), (v) => void bCommits.push(v)));
    flush();
    setGo(50);
    flush();
    assert(a.state() === "refreshing", "upstream refreshing after deps change");
    assert(a.latest() === 42, "latest() keeps prior value during refresh");
    await sleep(60);
    flush();
    assert(a.latest() === 100 && b.latest() === 101, "chain settles with new values");
    assert(
      bCommits.join(",") === "43,101",
      `downstream committed only consistent values (got ${bCommits})`,
    );

    // 4. diamond consistency
    const [s, setS] = createSignal(1);
    const slow = mk(() => cell(() => ({ v: s() }), async ({ v }) => { await sleep(35); return `slow${v}`; }));
    const fast = mk(() => cell(() => ({ v: s() }), async ({ v }) => { await sleep(5); return `fast${v}`; }));
    const pairs: string[] = [];
    const pair = mk(() => cell(() => ({ l: slow(), r: fast() }), ({ l, r }) => `${l}|${r}`));
    mk(() => createEffect(() => pair(), (v) => void pairs.push(v)));
    flush();
    await sleep(60);
    setS(2);
    flush();
    await sleep(80);
    flush();
    assert(
      pairs.join(",") === "slow1|fast1,slow2|fast2",
      `diamond commits are transactionally consistent (got ${pairs})`,
    );

    // 5. superseded runs aborted; stale results discarded
    let dAborts = 0;
    const dSeen: number[] = [];
    const [k, setK] = createSignal(1);
    const d = mk(() =>
      cell(
        () => ({ n: k() }),
        async ({ n }, ctx) => {
          dSeen.push(n);
          ctx.signal.addEventListener("abort", () => dAborts++);
          await sleep(40);
          return n;
        },
      ),
    );
    flush();
    await sleep(5);
    setK(2);
    flush();
    await sleep(5);
    setK(3);
    flush();
    await sleep(120);
    flush();
    assert(
      dAborts === 2 && d.latest() === 3 && d.state() === "ready",
      `superseded runs aborted (aborts=${dAborts}, value=${d.latest()}, seen=${dSeen})`,
    );

    // 6. streaming (stream: "commit"): per-yield graph commits + live progress
    const eCommits: number[] = [];
    const progLog: (number | undefined)[] = [];
    const e = mk(() =>
      cell(
        () => ({ go: true }),
        async function* (_d, ctx: CellContext<number>) {
          yield 1;
          await sleep(15);
          ctx.progress(0.5);
          yield 2;
          await sleep(15);
          ctx.progress(1);
          yield 3;
        },
      ),
    );
    const eDown = mk(() => cell(() => ({ v: e() }), ({ v }: { v: number }) => v * 10));
    mk(() =>
      createEffect(
        () => eDown.latest(),
        (v: number | undefined) => {
          if (v !== undefined) eCommits.push(v);
        },
      ),
    );
    mk(() => createEffect(e.progress, (p) => void progLog.push(p)));
    flush();
    await sleep(8);
    assert(e.state() === "streaming" && e.latest() === 1, "streaming state with first partial");
    await sleep(60);
    flush();
    assert(e.state() === "ready" && e.settled() && e.latest() === 3, "generator settles with last yield");
    assert(
      eCommits.join(",") === "10,20,30",
      `downstream recomputed per yield (got ${eCommits})`,
    );
    assert(
      progLog.filter((p) => p !== undefined).join(",") === "0.5,1",
      `progress observed live (got ${progLog})`,
    );

    // 7. settledOnly gates downstream on completed runs
    const fCommits: string[] = [];
    const f = mk(() => cell(() => ({ fin: settledOnly(e) }), ({ fin }) => `final:${fin}`));
    mk(() => createEffect(() => f.latest(), (v) => { if (v) fCommits.push(v); }));
    flush();
    await sleep(10);
    assert(fCommits.join(",") === "final:3", `settledOnly consumer sees only the final value (got ${fCommits})`);

    // 8. stream: "latest" — partials on latest() only, one graph commit
    const gCommits: number[] = [];
    const gcell = mk(() =>
      cell(
        () => ({ go: true }),
        async function* () {
          yield 10;
          await sleep(10);
          yield 20;
          await sleep(10);
          yield 30;
        },
        { stream: "latest" },
      ),
    );
    const gDown = mk(() => cell(() => ({ v: gcell() }), ({ v }) => v));
    mk(() =>
      createEffect(
        () => gDown.latest(),
        (v: number | undefined) => {
          if (v !== undefined) gCommits.push(v);
        },
      ),
    );
    flush();
    await sleep(8);
    assert(gcell.latest() === 10 && gcell.state() === "streaming", "latest-mode partial visible on latest()");
    await sleep(40);
    flush();
    assert(
      gCommits.join(",") === "30" && gcell.settled(),
      `latest-mode commits only the final value downstream (got ${gCommits})`,
    );

    // 8b. latest-mode superseded mid-stream: no unowned rejection, new run wins
    const [gv, setGv] = createSignal(1);
    const g2 = mk(() =>
      cell(
        () => ({ n: gv() }),
        async function* ({ n }) {
          yield n * 100 + 1;
          await sleep(30);
          yield n * 100 + 2;
        },
        { stream: "latest" },
      ),
    );
    flush();
    await sleep(5);
    setGv(2);
    flush();
    await sleep(60);
    flush();
    assert(g2.latest() === 202 && g2.state() === "ready", "superseded latest-mode run discarded cleanly");

    // 9. errors: state, kept value, retry via refetch (boundary reset)
    const [ev, setEv] = createSignal(1);
    let hRuns = 0;
    const h = mk(() =>
      cell(
        () => ({ v: ev() }),
        async ({ v }) => {
          hRuns++;
          await sleep(10);
          if (v === 2) throw new Error("bad2");
          return v * 10;
        },
      ),
    );
    flush();
    await sleep(30);
    assert(h.latest() === 10 && h.state() === "ready", "healthy first value");
    setEv(2);
    flush();
    await sleep(30);
    flush();
    assert(h.state() === "errored", "async error surfaces as errored state");
    assert(String((h.error() as Error)?.message).includes("bad2"), "error() exposes the thrown error");
    assert(h.latest() === 10, "latest() keeps last good value across the error");
    setEv(3);
    flush();
    await sleep(30);
    flush();
    assert(h.state() === "ready" && h.latest() === 30, "recovers when deps change");
    // force an error again, then retry with same deps
    setEv(2);
    flush();
    await sleep(30);
    flush();
    const runsBefore = hRuns;
    h.refetch(); // boundary reset → re-runs the failed computation
    flush();
    await sleep(30);
    flush();
    assert(hRuns === runsBefore + 1, "refetch() re-runs after error");
    assert(h.state() === "errored", "still errored when the retry hits the same bad input");

    // 10. refetch on a healthy cell re-runs with current deps
    const before = dSeen.length;
    d.refetch();
    flush();
    await sleep(60);
    flush();
    assert(dSeen.length === before + 1 && d.latest() === 3, "refetch re-runs with current deps");

    // 11. workerStream through a cell: partials, cancel on deps change
    const fw = new FakeWorker();
    const [vals, setVals] = createSignal<FakePayload>({ values: [10, 20, 30], delay: 25 });
    const wcell = mk(() =>
      cell(
        () => ({ p: vals() }),
        ({ p }, ctx: CellContext<number>) =>
          workerStream<FakePayload, number>(fw as unknown as Worker, p, ctx),
      ),
    );
    flush();
    await sleep(40);
    assert(wcell.latest() === 10 && wcell.state() === "streaming", "worker partial visible mid-run");
    setVals({ values: [7, 8], delay: 10 });
    flush();
    await sleep(60);
    flush();
    const cancelMsgs = fw.received.filter((m: any) => m.type === "cancel").length;
    assert(
      wcell.latest() === 8 && wcell.state() === "ready" && cancelMsgs === 1,
      `deps change cancels worker run, new run settles (value=${wcell.latest()}, cancels=${cancelMsgs})`,
    );

    // 12. workerStream burst ordering (gate race), standalone
    const fw2 = new FakeWorker();
    const got: number[] = [];
    for await (const v of workerStream<FakePayload, number>(
      fw2 as unknown as Worker,
      { values: [1, 2, 3, 4], delay: 0, burst: true },
      { signal: new AbortController().signal },
    )) {
      got.push(v);
      await sleep(5);
    }
    assert(got.join(",") === "1,2,3,4", `burst partials delivered in order (got=${got})`);

    // 13. fromWorker factory infers and runs
    const fw3 = new FakeWorker();
    const tw = mk(() =>
      cell(() => ({ values: [5, 6], delay: 5 }), fromWorker<FakePayload, number>(fw3 as unknown as Worker)),
    );
    flush();
    await sleep(50);
    flush();
    assert(tw.latest() === 6 && tw.settled(), "fromWorker cell settles");

    // 14. held-with-stale reads as refreshing (documented mapping)
    setGo(undefined);
    flush();
    assert(
      a.latest() === 100 && a.state() === "refreshing",
      `re-held cell keeps stale value and reads as refreshing (state=${a.state()})`,
    );
    setGo(7);
    flush();
    await sleep(40);
    flush();
    assert(a.latest() === 14, "recovers from re-hold");

    dispose();
  });

  // 15. dispose aborts in-flight runs
  let disposed = false;
  await createRoot(async (d2) => {
    const c = cell(
      () => ({ go: true }),
      async (_d, ctx) => {
        ctx.signal.addEventListener("abort", () => (disposed = true));
        await sleep(50);
        return 1;
      },
    );
    void c;
    flush();
    await sleep(10);
    d2();
  });
  await sleep(10);
  assert(disposed, "root disposal aborts in-flight run");

  console.log(failures === 0 ? "\nALL TESTS PASSED" : `\n${failures} FAILURES`);
  if (failures > 0) throw new Error(`${failures} test failure(s)`);
}

void main();
```

## Desideratum: a `redefine` primitive — hot-swapping a cell's compute in place

A capability worth adding, motivated in [`solid-cells-motivation.md`](solid-cells-motivation.md) and by the agentic HMR loop in [`../agentic_ui_workflow/hmr_for_agentic_coding.md`](../agentic_ui_workflow/hmr_for_agentic_coding.md): let a live cell **replace its `deps`/`compute` while keeping its identity, its cached last value, and its downstream edges**. The one-line rationale — *a code edit is just another cause of invalidation* — maps directly onto the machinery this file already has. When an input changes, `cell()` aborts the stale run (the `onCleanup(() => ctrl.abort())` at line 200), serves `last` (the cross-run value cache) while the new run is pending, and re-runs via `refresh(memo)` (already imported and used at line 327). An edit to the compute wants that same path; today `refresh` only re-runs the **same** compute, so an HMR update has to rebuild the cell from scratch and lose the cache.

### Where it slots in

The memo at line 194 closes directly over `deps` and `compute`. The minimal change is to read them through swappable refs instead, then expose a method that reassigns and refreshes — the same mutable-facade move used elsewhere in this codebase:

```ts
export function cell<D, T>(deps0: Deps<D>, compute0: CellCompute<D, T>, options?: CellOptions): Cell<T> {
  let curDeps = deps0;         // was captured directly by the memo…
  let curCompute = compute0;   // …now swappable
  // …existing signals (progress/settled/partial/last) unchanged…

  const memo = createMemo<T>((prev) => {
    const d = curDeps();                       // ← read through the ref
    if (d == null || d === false) throw new NotReadyError(null);
    const ctrl = new AbortController();
    onCleanup(() => ctrl.abort());
    const ctx = /* …unchanged… */;
    const out = curCompute(d, ctx);            // ← read through the ref
    /* …unchanged async/thenable/sync handling… */
  });

  function redefine(compute: CellCompute<D, T>, deps?: Deps<D>) {
    curCompute = compute;
    if (deps) curDeps = deps;
    refresh(memo);   // supersede in flight, keep `last`, re-run, propagate to dependents
  }

  return { /* …existing surface… */ redefine };
}
```

Two properties come free from the 2.0 core: because tracking is **dynamic per run**, a new compute that reads different inputs re-establishes its dependency edges on the next run — swapping `deps` needs no graph surgery; and a cell mid-`yield` when redefined is superseded exactly as an input change supersedes it (`ctx.signal` aborts, the async generator's `finally` runs once its in-flight `await` settles — see the `commitStream` abort checks at lines 239/245).

### Calls left to the implementer

These are genuinely open; decide them with the whole system in view rather than treating the sketch above as settled:

- **Identity across structural edits.** `redefine` only helps when the HMR layer can match the new cell definition to the existing instance — which wants stable, addressable cell identity (naming/keying, likely via `cellGraph`), not positional identity. Renames and splits are the hard case; an agent performing the edit can *emit* the old→new mapping, an affordance a human HMR setup never had.
- **Shape-incompatible edits.** If the new compute's output shape breaks downstream consumers or the cached `last`, a silent swap is worse than a reset. Pair `redefine` with a "not hot-safe → fail loud, force a clean reload" escape hatch (the HMR doc argues this in general).
- **Cancel-and-restart vs. let-it-finish** for a long in-flight run, and whether `redefine` should default to `refresh` semantics or `refetch` (error-boundary reset) when the cell is currently `errored`. Probably a per-cell policy.
- **Whether `redefine` belongs on the public `Cell` surface at all, or only on a graph/registry handle** the HMR layer holds — an application rarely wants to redefine a cell itself, but the reload machinery does.

Recorded here as a starting point to build on, not a spec to follow.
