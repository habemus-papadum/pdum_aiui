# solid-cells — Observable-style async dataflow cells for SolidJS

A small library (~150 lines) that gives SolidJS 1.x the part of the Observable notebook runtime that matters for high-iteration scientific/quant UIs: a **value-level async dependency graph**. Each data node ("cell") carries its own pending / progress / error / stale state; downstream computations hold until their inputs are ready; superseded runs are aborted; long computations can stream partial results; and one generic view component renders any cell with sensible loading chrome — including keeping the last chart visible (dimmed, with a progress stripe) while a new run computes, instead of flashing a spinner on every parameter tweak.

Everything below was type-checked with `tsc --noEmit` (strict) and the runtime semantics were verified with the test harness in the appendix, against **solid-js 1.9.14**, **TypeScript 6.0.3**, **@observablehq/plot 0.6.17**, Node 22.

## Mapping to the Observable runtime

| Observable runtime | solid-cells |
|---|---|
| `variable.define(name, inputs, fn)` | `const c = cell(deps, compute)` — deps is a tracked function, not string names |
| A cell waits until all inputs fulfill | `deps` returning `undefined` holds the cell; `ready(a, b, ...)` builds that gate from upstream cells/signals |
| Recompute when any input changes | Any signal/cell read inside `deps` re-triggers `compute` |
| `invalidation` promise | `ctx.signal` (`AbortSignal`) — aborted when a newer run supersedes this one or the owner is disposed |
| Generator cells (value = latest yield) | `compute` may return an async iterable; each yield is published as a partial, the last yield settles the cell |
| Pending / fulfilled / rejected observer states | `c.state()`: `unresolved · pending · ready · refreshing · errored`, plus `c.loading()`, `c.error()`, `c.progress()` |
| Cell output area (spinner, error display) | `<CellView of={c}>{v => ...}</CellView>` |

## Deliberate divergences from Observable

These are choices, not omissions. **Partials do not re-trigger downstream cells** — only settlement does. In Observable every `yield` re-runs dependents, which is right for animation but causes recomputation storms in analytics pipelines; here, streamed partials are a UI affordance (visible via `c.latest()` and `CellView`) while `ready()`-gated dependents see only consistent, completed values. **Evaluation is eager**: a cell runs as soon as its deps are available, whether or not anything reads it (Observable only computes observed cells). **Stale values are kept**: while recomputing, `c.latest()` returns the previous value and `CellView` keeps rendering it dimmed — an improvement over the notebook behavior of blanking the output. **Glitch-freedom comes from state, not topology**: a cell flips out of `"ready"` *synchronously* when its inputs change, so a diamond dependency gated with `ready()` can never fire with mixed old/new values (verified in test 3 below).

## Files

```
src/
  cell.ts           the primitive: cell(), ready(), cellGraph()
  cell-view.tsx     <CellView> — generic loading/progress/error/stale wrapper
  worker-stream.ts  cancellable request/stream protocol for Web Workers + fromWorker()
  mc.worker.ts      demo worker: streaming Monte Carlo GBM band
  App.tsx           demo app: sliders → worker cell → Observable Plot
```

## src/cell.ts

```ts
/**
 * cell.ts — Observable-style async dataflow cells for SolidJS 1.x.
 *
 * A cell is a node in a value-level async dependency graph:
 *   - it holds (doesn't run) until its inputs are ready,
 *   - it recomputes when any input changes,
 *   - a superseded run is aborted via AbortSignal (Observable's `invalidation`),
 *   - it can stream partial results (Observable's generator cells) and report
 *     progress, both of which are visible to the UI as reactive state.
 *
 * Built on `createResource`, so cells also integrate with <Suspense> and
 * transitions if you want boundary-style coordination — but the intended use
 * is data-driven: read `.latest()` / `.loading()` / `.progress()` anywhere.
 */
import {
  createResource,
  createRoot,
  createSignal,
  onCleanup,
  type Accessor,
} from "solid-js";

export type CellState =
  | "unresolved" // never had deps; never ran
  | "pending"    // first run in flight
  | "ready"      // has a settled value
  | "refreshing" // has a value, new run in flight
  | "errored";

export interface CellContext<T> {
  /** Aborted when a newer run supersedes this one, or when the owner is disposed. */
  signal: AbortSignal;
  /** Report progress in [0, 1]; resets to undefined at the start of each run. */
  progress: (fraction: number) => void;
  /** Publish an intermediate value (same effect as `yield` in an async generator). */
  emit: (value: T) => void;
  /** The previous settled value, if any — useful for warm starts. */
  previous: T | undefined;
}

export type CellCompute<D, T> = (
  deps: D,
  ctx: CellContext<T>,
) => T | Promise<T> | AsyncIterable<T>;

export interface Cell<T> {
  /**
   * Best current value: a streamed partial if one exists, else the resource
   * value. Reading this under <Suspense> before the first value triggers the
   * boundary; use `.latest()` if you never want Suspense semantics.
   */
  (): T | undefined;
  /** Last settled or streamed value; never triggers Suspense. */
  latest: Accessor<T | undefined>;
  /** True while a run is in flight (pending or refreshing). */
  loading: Accessor<boolean>;
  error: Accessor<unknown>;
  state: Accessor<CellState>;
  /** Progress of the current run in [0, 1], or undefined if not reported. */
  progress: Accessor<number | undefined>;
  /** Re-run with the current deps (aborts any in-flight run). */
  refetch: () => void;
}

/**
 * Create a cell.
 *
 * `deps` is a synchronous, tracked function (like a memo body). Returning
 * `undefined` (or null/false) holds the cell — this is how "a cell doesn't run
 * until its inputs fulfill" is expressed. Any signal/cell read inside `deps`
 * re-triggers the cell when it changes.
 *
 * `compute` may return a plain value, a promise, or an async iterable (e.g. an
 * async generator). For async iterables, each yielded value is published as a
 * partial (visible via `latest()` while `loading()` is still true) and the
 * last yielded value becomes the settled value.
 *
 * Must be called under a reactive owner (a component, or `cellGraph` /
 * `createRoot` for module-scope graphs).
 */
export function cell<D, T>(
  deps: Accessor<D | undefined | null | false>,
  compute: CellCompute<D, T>,
): Cell<T> {
  let ctrl: AbortController | undefined;
  const [progress, setProgress] = createSignal<number | undefined>(undefined);
  // Boxed so `undefined` values are representable; equals:false so every emit
  // notifies, even if the same object is re-yielded after in-place mutation
  // (Observable generator semantics).
  const [partial, setPartial] = createSignal<{ value: T } | undefined>(
    undefined,
    { equals: false },
  );

  const [r, { refetch }] = createResource<T, D>(deps, (d, info) => {
    ctrl?.abort();
    const ac = (ctrl = new AbortController());
    setProgress(undefined);
    setPartial(undefined);
    const ctx: CellContext<T> = {
      signal: ac.signal,
      previous: info.value,
      progress: (fraction) => {
        if (!ac.signal.aborted) setProgress(fraction);
      },
      emit: (value) => {
        if (!ac.signal.aborted) setPartial({ value });
      },
    };
    const out = compute(d, ctx);
    return isAsyncIterable<T>(out) ? drain(out, ctx) : out;
  });

  onCleanup(() => ctrl?.abort());

  const read = (() => {
    const p = partial();
    if (p) {
      r.state; // subscribe so readers update when the run settles
      return p.value;
    }
    return r();
  }) as Cell<T>;

  read.latest = () => {
    const p = partial();
    return p ? p.value : r.latest;
  };
  read.loading = () => r.loading;
  read.error = () => r.error;
  read.state = () => r.state;
  read.progress = progress;
  read.refetch = () => void refetch();
  return read;
}

async function drain<T>(source: AsyncIterable<T>, ctx: CellContext<T>): Promise<T> {
  let last: { value: T } | undefined;
  for await (const value of source) {
    if (ctx.signal.aborted) break; // for-await calls .return() on the generator
    last = { value };
    ctx.emit(value);
  }
  if (ctx.signal.aborted) {
    // Rejecting a superseded run is fine: the resource ignores stale promises.
    throw ctx.signal.reason ?? new DOMException("Cell run superseded", "AbortError");
  }
  if (!last) {
    throw new Error("cell: async iterable finished without yielding a value");
  }
  return last.value;
}

function isAsyncIterable<T>(x: unknown): x is AsyncIterable<T> {
  return (
    x != null &&
    typeof (x as AsyncIterable<T>)[Symbol.asyncIterator] === "function"
  );
}

// ---------------------------------------------------------------------------
// ready(): dependency gate
// ---------------------------------------------------------------------------

/** A dependency source: another cell, or any accessor (plain signals, memos). */
export type DepSource<T> = Cell<T> | Accessor<T | undefined>;

type DepValues<S extends readonly DepSource<unknown>[]> = {
  [K in keyof S]: S[K] extends DepSource<infer T> ? T : never;
};

/**
 * Gate a cell on upstream sources. Returns a deps function that yields the
 * tuple of current values once every source is available, and `undefined`
 * otherwise (holding the downstream cell).
 *
 * - Cells count as available only when `state() === "ready"`. Because an
 *   upstream cell flips to "pending"/"refreshing" *synchronously* when its own
 *   inputs change, diamond dependencies never fire with mixed old/new values.
 * - Plain accessors count as available when they return anything but
 *   `undefined` (so `undefined` is the universal "hold" sentinel).
 *
 * Early-return on the first unavailable source is safe conditional tracking:
 * sources after it aren't subscribed yet, but their changes can't matter until
 * the earlier gate opens — at which point re-evaluation subscribes to them.
 */
export function ready<const S extends readonly DepSource<unknown>[]>(
  ...sources: S
): Accessor<DepValues<S> | undefined> {
  return () => {
    const values: unknown[] = [];
    for (const s of sources) {
      if (isCell(s)) {
        if (s.state() !== "ready") return undefined;
        values.push(s.latest());
      } else {
        const v = s();
        if (v === undefined) return undefined;
        values.push(v);
      }
    }
    return values as unknown as DepValues<S>;
  };
}

function isCell(x: DepSource<unknown>): x is Cell<unknown> {
  return typeof (x as Cell<unknown>).state === "function";
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
 *     const fit = cell(ready(prices), ...);
 *     return { prices, fit };
 *   });
 *
 * The graph lives for the lifetime of the app. Under Vite HMR, guard with
 * `import.meta.hot?.dispose(...)` or move the graph into a context provider
 * if you need clean disposal on module reload.
 */
export function cellGraph<T>(setup: () => T): T {
  return createRoot(() => setup());
}
```

## src/cell-view.tsx

```tsx
/**
 * cell-view.tsx — one generic wrapper that gives every visualization the
 * "notebook feel": spinner + progress while pending, error box with retry,
 * and (crucially, for iteration workflows) keep-the-last-render-while-
 * recomputing instead of flashing a spinner on every parameter tweak.
 *
 * The wrapper is driven entirely by the cell's own state — no per-component
 * loading plumbing.
 */
import { Match, Show, Switch, type Accessor, type JSX } from "solid-js";
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
    if (s === "errored" || s === "unresolved") return false;
    // pending/refreshing: show the last settled value or a streamed partial
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
 * Partials stream into the cell (visible via latest()), progress messages
 * drive ctx.progress, and aborting the cell posts a "cancel" message so the
 * worker actually stops computing.
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
 * App.tsx — demo: a module-scope cell graph driving Observable Plot.
 *
 * Drag a slider → the worker run in flight is cancelled, a new one starts,
 * the previous chart stays visible (dimmed, with a progress stripe), and the
 * band streams in as paths accumulate. The `summary` cell only fires when
 * `band` settles — downstream cells see consistent, completed values.
 */
import { createEffect, createSignal, onCleanup, type JSX } from "solid-js";
import { render } from "solid-js/web";
import * as Plot from "@observablehq/plot";
import { cell, cellGraph, ready } from "./cell";
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

  // Sync derivation; runs only when `band` settles.
  const summary = cell(ready(band), ([b]) => {
    const last = b.mean.length - 1;
    return {
      simulated: b.nPaths,
      terminalMean: b.mean[last],
      terminalLo: b.lo[last],
      terminalHi: b.hi[last],
    };
  });

  return { band, summary };
});

// --- Observable Plot bridge -------------------------------------------------

function PlotFigure(props: { options: Plot.PlotOptions }) {
  let host!: HTMLDivElement;
  createEffect(() => {
    const figure = Plot.plot(props.options);
    host.replaceChildren(figure);
    onCleanup(() => figure.remove());
  });
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
      <h1 style={{ "font-size": "17px" }}>Monte Carlo GBM — streaming cell demo</h1>

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
    </main>
  );
}

render(() => <App />, document.getElementById("root")!);
```

## Project scaffold

Scaffold with Vite's Solid template and add the two runtime deps (Plot is only for the demo):

```bash
npm create vite@latest my-app -- --template solid-ts
cd my-app && npm i solid-js @observablehq/plot
```

`index.html` needs a `<div id="root"></div>`; point the entry at `src/App.tsx`. Vite handles `new Worker(new URL("./mc.worker.ts", import.meta.url), { type: "module" })` natively. The `import type { McBand } from "./mc.worker"` in App.tsx is type-only, so no worker code leaks into the main bundle.

The code above type-checks under this tsconfig (the one it was verified with):

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "jsx": "preserve",
    "jsxImportSource": "solid-js",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true
  },
  "include": ["src"]
}
```

In a real project, give worker files their own tsconfig with `"lib": ["ES2022", "WebWorker"]` and drop the `self` cast in `mc.worker.ts` — the cast only exists so the demo compiles under a single DOM-lib config.

## Usage patterns

**A plain fetch cell.** `ctx.signal` goes straight into `fetch`, so a slider change aborts the in-flight request:

```ts
const prices = cell(
  () => {
    const s = symbol();               // plain signals work as inputs
    return s ? { symbol: s, days: lookback() } : undefined;  // undefined = hold
  },
  async ({ symbol, days }, ctx) => {
    const res = await fetch(`/api/prices/${symbol}?days=${days}`, { signal: ctx.signal });
    if (!res.ok) throw new Error(`prices: ${res.status}`);
    return (await res.json()) as PricePoint[];
  },
);

const fit = cell(ready(prices, lambda), ([px, l], ctx) => fitModel(px, l, ctx.signal));
```

**Warm starts.** `ctx.previous` is the last settled value — seed an optimizer with the previous solution when a parameter nudges:

```ts
const weights = cell(ready(signals, gamma), ([s, g], ctx) =>
  solvePortfolio(s, g, { init: ctx.previous, signal: ctx.signal }),
);
```

**Module-scope graphs.** Define the graph once, notebook-style, with `cellGraph(...)` (it provides the reactive owner), and import it from any component. Components become pure views over the graph.

**Streaming without a worker.** Any async generator works — yield intermediate fits during an optimization loop and the UI (via `latest()`) updates while `loading()` stays true.

**Suspense is optional.** Reading `c()` under a `<Suspense>` boundary before the first value participates in the boundary (cells are `createResource` underneath), and `refetch`/deps changes work with `useTransition`. `CellView` and `.latest()` never suspend; pick per call site.

**Caching / request dedup** is out of scope on purpose: for keyed, cached, retried IO use TanStack Solid Query and feed its results into cells as plain accessors; cells then handle derivation, gating, and streaming.

**Solid 2.0 note.** Solid 2.x (in beta as of mid-2026) makes async first-class — promises can flow through `createMemo` and the graph tracks settlement itself. On 2.x much of `cell()` collapses into core primitives, but the `deps`-gating idiom, `AbortSignal` invalidation, and streamed partials remain the same shape, so code written against this API migrates mechanically.

## TypeScript inference notes

Inference of the cell's value type `T` comes from the compute function's return type, and it works for plain values, promises, and inline async generators. The one pattern that defeats it is an inline lambda that both leaves `ctx` unannotated *and* references it — e.g. `(p, ctx) => workerStream<In, Out>(w, p, ctx)`. An untyped parameter makes the callback context-sensitive, and referencing `ctx: CellContext<T>` pins `T` to `unknown` before the return type is considered. Two clean outs, in order of preference: use the `fromWorker<In, Out>(worker)` factory (fully annotated, infers perfectly), or annotate the parameter: `(p, ctx: CellContext<Out>) => ...`. Requires TS ≥ 5.0 (`const` type parameters in `ready()`); verified on TS 6.

## Caveats

- `undefined` is the universal "hold" sentinel in `deps` functions and for plain accessors inside `ready()`. Cells themselves gate on `state()`, so a cell may legitimately *resolve* to `undefined` — but `CellView`'s keep-stale check treats `latest() === undefined` as "nothing to show", so prefer wrapping optional results in an object.
- If a run errors mid-stream, `state()` becomes `"errored"` while `latest()` still returns the last partial — "last known value" semantics. Check `error()` (or let `CellView` handle it) rather than inferring health from the presence of a value.
- Deps tuples are rebuilt on every evaluation, so any tracked change re-runs the cell even if the tuple is deep-equal. That is the intended semantic; to cut on equality, wrap the deps computation in `createMemo(..., { equals: yourEq })` and pass that memo.
- If a cell's *value type* is itself an async iterable, `cell()` will drain it. Wrap it in an object.
- `refetch()` re-runs with current deps and aborts any in-flight run; disposal of the owning root aborts too.
- For module-scope graphs under Vite HMR, add `import.meta.hot?.dispose(...)` handling or move the graph into a context provider if reload leaks matter during development.

## Appendix: verified behavior

The following assertions all pass (Node 22, solid-js browser build). They double as an executable specification: holds while deps are undefined; `loading()` true synchronously after deps arrive; no value before first resolution; resolves to computed value; downstream computes from upstream value via `ready()`; upstream enters `refreshing` synchronously; `ready()` gates while upstream refreshes; `latest()` keeps the prior value during refresh; chains settle with new values; superseded runs aborted (2 aborts on 2 rapid flips, stale `AbortError` rejections ignored, final value correct); first yield visible via `latest()` while loading; progress + second partial observed; generator settles with last yield; `ready()` holds on an undefined plain accessor; mixed cell + accessor deps fire together; a synchronous burst of worker partials is delivered in order to a slow consumer (the gate-race case); worker partial visible mid-run through a cell; a deps change posts exactly one `cancel` to the worker and the new run settles; `refetch()` re-runs with current deps.

To re-run: put the test below at `test/test.ts`, compile with a CommonJS tsconfig (`"module": "CommonJS"`, `"moduleResolution": "node10"`, `"ignoreDeprecations": "6.0"`, include `src/cell.ts`, `src/worker-stream.ts`, `test/test.ts`, `"outDir": "dist-test"`), then run **`node --conditions browser dist-test/test/test.js`** — the flag selects solid's reactive browser build; the harness detects and refuses the non-reactive server build.

```ts
import {
  createEffect,
  createRoot,
  createSignal,
  getOwner,
  runWithOwner,
} from "solid-js";
import { cell, ready, type CellContext } from "../src/cell";
import { workerStream } from "../src/worker-stream";

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
        // synchronous burst of partials then done — exercises the gate race
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
  // sanity: are we on the reactive (browser) build?
  let effectRuns = 0;
  let bump = () => {};
  createRoot(() => {
    const [x, setX] = createSignal(0);
    bump = () => setX((v) => v + 1);
    createEffect(() => {
      x();
      effectRuns++;
    });
  });
  await sleep(0);
  bump();
  await sleep(0);
  if (effectRuns < 2) {
    throw new Error(
      "solid-js resolved to a non-reactive build; run with --conditions browser",
    );
  }

  await createRoot(async (dispose) => {
    const owner = getOwner();
    const mk = <T,>(fn: () => T): T => runWithOwner(owner, fn) as T;

    // 1. gating: deps undefined → never runs
    let aRuns = 0;
    const [go, setGo] = createSignal<number | undefined>(undefined);
    const a = mk(() =>
      cell(go, async (n) => {
        aRuns++;
        await sleep(20);
        return n * 2;
      }),
    );
    await sleep(40);
    assert(aRuns === 0 && a.state() === "unresolved", "holds while deps are undefined");

    setGo(21);
    assert(a.loading() === true && a.state() === "pending", "loading synchronously after deps arrive");
    assert(a() === undefined, "no value before first resolution");
    await sleep(40);
    assert(a() === 42 && a.state() === "ready", "resolves to computed value");

    // 2. chaining via ready()
    const b = mk(() => cell(ready(a), async ([av]) => {
      await sleep(10);
      return av + 1;
    }));
    await sleep(40);
    assert(b.latest() === 43, "downstream computes from upstream value");

    // 3. glitch-freedom: upstream flips out of ready synchronously
    setGo(50);
    assert(a.state() === "refreshing", "upstream enters refreshing synchronously");
    assert(ready(a)() === undefined, "ready() gates while upstream refreshes");
    assert(a.latest() === 42, "latest() keeps prior value during refresh");
    await sleep(80);
    assert(a() === 100 && b.latest() === 101, "chain settles with new values");

    // 4. superseded runs are aborted; stale rejections ignored
    let dAborts = 0;
    const dSeen: number[] = [];
    const [k, setK] = createSignal(1);
    const d = mk(() =>
      cell(
        () => k(),
        async (n, ctx) => {
          dSeen.push(n);
          ctx.signal.addEventListener("abort", () => dAborts++);
          await sleep(50);
          if (ctx.signal.aborted) throw new DOMException("aborted", "AbortError");
          return n;
        },
      ),
    );
    await sleep(10);
    setK(2);
    await sleep(10);
    setK(3);
    await sleep(120);
    assert(
      dAborts === 2 && d() === 3 && d.state() === "ready",
      `superseded runs aborted (aborts=${dAborts}, value=${d()}, seen=${dSeen})`,
    );

    // 5. streaming: async generator partials + progress
    const e = mk(() =>
      cell(
        () => 1,
        async function* (_n, ctx) {
          yield 1;
          await sleep(15);
          ctx.progress(0.5);
          yield 2;
          await sleep(15);
          yield 3;
        },
      ),
    );
    await sleep(5);
    assert(e.loading() === true && e.latest() === 1, "first yield visible via latest() while loading");
    await sleep(20);
    assert(e.progress() === 0.5 && e.latest() === 2, "progress + second partial");
    await sleep(30);
    assert(e.state() === "ready" && e() === 3 && e.progress() === 0.5, "generator settles with last yield");

    // 6. mixed cell + plain accessor deps; undefined accessor holds
    const [tag, setTag] = createSignal<string | undefined>(undefined);
    const f = mk(() => cell(ready(e, tag), ([ev, t]) => `${t}:${ev}`));
    await sleep(10);
    assert(f.state() === "unresolved", "ready() holds on undefined plain accessor");
    setTag("x");
    await sleep(10);
    assert(f() === "x:3", "mixed cell + accessor deps fire together");

    // 7. workerStream: synchronous burst ordering (gate race)
    const fw = new FakeWorker();
    const burstCtx = { signal: new AbortController().signal };
    const got: number[] = [];
    for await (const v of workerStream<FakePayload, number>(
      fw as unknown as Worker,
      { values: [1, 2, 3, 4], delay: 0, burst: true },
      burstCtx,
    )) {
      got.push(v);
      await sleep(5); // slow consumer vs burst producer
    }
    assert(got.join(",") === "1,2,3,4", `burst partials all delivered in order (got=${got})`);

    // 8. workerStream driven by a cell: partials stream, cancel on deps change
    const fw2 = new FakeWorker();
    const [vals, setVals] = createSignal<FakePayload>({ values: [10, 20, 30], delay: 25 });
    const g = mk(() =>
      cell(vals, (p, ctx: CellContext<number>) =>
        workerStream<FakePayload, number>(fw2 as unknown as Worker, p, ctx),
      ),
    );
    await sleep(40);
    assert(g.loading() === true && g.latest() === 10, "worker partial visible mid-run");
    setVals({ values: [7, 8], delay: 10 });
    await sleep(60);
    const cancelMsgs = fw2.received.filter((m: any) => m.type === "cancel").length;
    assert(
      g() === 8 && g.state() === "ready" && cancelMsgs === 1,
      `deps change cancels worker run and new run settles (value=${g()}, cancels=${cancelMsgs})`,
    );

    // 9. refetch: re-runs with same deps, aborting nothing in flight
    const before = dSeen.length;
    d.refetch();
    await sleep(70);
    assert(dSeen.length === before + 1 && d() === 3, "refetch re-runs with current deps");

    dispose();
  });

  console.log(failures === 0 ? "\nALL TESTS PASSED" : `\n${failures} FAILURES`);
  if (failures > 0) throw new Error(`${failures} test failure(s)`);
}

void main();
```
