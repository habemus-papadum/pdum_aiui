/**
 * shuffle.worker.ts — EKLP growth and permanent-counting, off the main thread.
 *
 * Speaks the cancellable request/stream protocol of @habemus-papadum/aiui-viz
 * (worker-stream). Two request kinds share one worker:
 *
 *   - "shuffle": grow AD(1) → AD(targetN), streaming a ShuffleFrame per growth
 *     step (or every `emitEvery` steps for large targets), reporting progress,
 *     and yielding to the event loop between steps so a "cancel" is actually
 *     seen (message events are macrotasks — a microtask yield never would).
 *   - "permanents": Ryser's permanent of AD(n)'s biadjacency matrix for
 *     n = 1..maxN, checked against 2^(n(n+1)/2). Cached, since it never changes.
 *
 * All the math is in the pure sibling modules (shuffle.ts, permanent.ts); this
 * file is only choreography.
 */

import type { WorkerReply, WorkerRequest } from "@habemus-papadum/aiui-viz";
import { biadjacency, ryserPermanent, tilingCount } from "./permanent";
import { mulberry32 } from "./rng";
import { frozenFraction, initTiling, rasterize, step, type Tiling } from "./shuffle";
import type { PermanentCheck, PermanentResult, ShuffleFrame, ShuffleRequest } from "./types";

const scope = self as unknown as {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage: (message: unknown) => void;
};

type Out = ShuffleFrame | PermanentResult;
const cancelled = new Set<number>();
const post = (message: WorkerReply<Out>) => scope.postMessage(message);
const yieldToEvents = () => new Promise((resolve) => setTimeout(resolve, 0));

let permCache: PermanentCheck[] | undefined;

function frameOf(t: Tiling): ShuffleFrame {
  return {
    n: t.n,
    size: 2 * t.n,
    grid: Array.from(rasterize(t)),
    dominoes: t.dominoes.length,
    frozenFraction: frozenFraction(t),
  };
}

scope.onmessage = async (event: MessageEvent) => {
  const msg = event.data as WorkerRequest<ShuffleRequest>;
  if (msg.type === "cancel") {
    cancelled.add(msg.id);
    return;
  }
  if (msg.type !== "run") return;
  const { id, payload } = msg;
  const isCancelled = () => {
    if (cancelled.has(id)) {
      cancelled.delete(id);
      return true;
    }
    return false;
  };

  try {
    if (payload.kind === "permanents") {
      if (!permCache || permCache.length < payload.maxN) {
        const rows: PermanentCheck[] = [];
        for (let n = 1; n <= payload.maxN; n++) {
          await yieldToEvents();
          if (isCancelled()) return;
          const M = biadjacency(n);
          const permanent = ryserPermanent(M);
          const formula = tilingCount(n);
          rows.push({ n, size: M.length, permanent, formula, matches: permanent === formula });
          post({ id, type: "progress", value: n / payload.maxN });
          post({ id, type: "partial", value: { permanents: [...rows] } });
        }
        permCache = rows;
      } else {
        post({ id, type: "partial", value: { permanents: permCache.slice(0, payload.maxN) } });
      }
      post({ id, type: "done", value: { permanents: permCache.slice(0, payload.maxN) } });
      return;
    }

    // kind === "shuffle"
    const rng = mulberry32(payload.seed);
    let t = initTiling(rng);
    post({ id, type: "partial", value: frameOf(t) }); // n = 1
    while (t.n < payload.targetN) {
      await yieldToEvents();
      if (isCancelled()) return;
      t = step(t, rng);
      // The final order is delivered by `done`, so skip it here (no duplicate).
      if (t.n % payload.emitEvery === 0 && t.n !== payload.targetN) {
        post({ id, type: "partial", value: frameOf(t) });
      }
      post({ id, type: "progress", value: t.n / payload.targetN });
    }
    post({ id, type: "done", value: frameOf(t) });
  } catch (err) {
    post({ id, type: "error", message: err instanceof Error ? err.message : String(err) });
  }
};
