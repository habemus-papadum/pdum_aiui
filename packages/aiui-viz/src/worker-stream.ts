/**
 * worker-stream.ts — dependency-free request/stream protocol for Web Workers
 * (from archive/reactive-flows/solid-cells-solidjs_v2.md).
 *
 * `workerStream()` returns an async generator, so a cell can consume a worker
 * directly. Partials stream into the cell, progress messages drive
 * ctx.progress, and aborting the cell posts a "cancel" message so the worker
 * actually stops computing. Under Solid 2.0, a superseded run's generator is
 * finalized by the framework (its finally runs), which detaches the listeners.
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
 * Typed compute factory: the ergonomic way to point a cell at a worker —
 * `cell(params, fromWorker<In, Out>(worker))` — with full type inference.
 * The worker is passed as an accessor so a durable (HMR-adopted) instance
 * can be resolved lazily.
 */
export function fromWorker<TIn, TOut>(worker: Worker | (() => Worker)) {
  return (
    payload: TIn,
    ctx: { signal: AbortSignal; progress?: (fraction: number) => void },
  ): AsyncGenerator<TOut, void, void> =>
    workerStream<TIn, TOut>(typeof worker === "function" ? worker() : worker, payload, ctx);
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
  let gate = new Promise<void>((resolve) => {
    wake = resolve;
  });
  const bump = () => {
    const w = wake;
    gate = new Promise<void>((resolve) => {
      wake = resolve;
    });
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
        yield queue.shift() as TOut;
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
