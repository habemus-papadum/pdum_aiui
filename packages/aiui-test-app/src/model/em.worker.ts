/**
 * em.worker.ts — the seam between layers 1 and 2: a THIN shell speaking the
 * aiui-viz worker protocol around the pure math in ./mixture2d (JS backend)
 * and the compute kernel in ./em-gpu (WebGPU backend). No mathematics lives
 * here; no framework code either (`import type` from the barrel is erased).
 *
 * The choreography the hard-won ledger prescribes: one EM iteration per
 * chunk, a REAL macrotask between chunks (`setTimeout 0` — a micro-yield
 * never lets the `cancel` message be delivered), `progress` per iteration,
 * cumulative `partial` steps (each carries the whole logLik trace so far),
 * and `done` carrying the final step alone.
 *
 * Backend resolution happens HERE, per run: `webgpu` is a request, not a
 * promise — if the adapter is missing or dies mid-run, the run continues on
 * JS and every subsequent step reports `backend: "js"`. The UI shows what
 * actually computed.
 */
import type { WorkerReply, WorkerRequest } from "@habemus-papadum/aiui-viz";
import { EmGpu, MAX_K } from "./em-gpu";
import {
  emStep2d,
  type FitStep2D,
  initialGuess2d,
  type Mixture2D,
  mStepFromSums,
  mulberry32,
} from "./mixture2d";

/** What the fit cell sends down. */
export interface EmRunParams {
  /** Interleaved xy, board units. */
  data: Float64Array;
  /** Number of components to fit (= ellipses drawn). */
  k: number;
  seed: number;
  iterations: number;
  /** Pause between iterations, ms — what makes the stream watchable. */
  frameMs: number;
  backend: "js" | "webgpu";
}

/** The streamed value: one EM iteration plus the run's history. */
export interface EmProgress extends FitStep2D {
  /** logLik of every completed iteration, oldest first. */
  trace: number[];
  /** The backend that actually computed this step. */
  backend: "js" | "webgpu";
}

const cancelled = new Set<number>();

self.onmessage = (e: MessageEvent<WorkerRequest<EmRunParams>>) => {
  const msg = e.data;
  if (msg.type === "cancel") {
    cancelled.add(msg.id);
    return;
  }
  if (msg.type === "run") {
    void run(msg.id, msg.payload);
  }
};

const post = (reply: WorkerReply<EmProgress>) => self.postMessage(reply);
const macrotask = () => new Promise<void>((r) => setTimeout(r, 0));
const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function run(id: number, p: EmRunParams): Promise<void> {
  let gpu: EmGpu | null = null;
  try {
    if (p.backend === "webgpu" && p.k <= MAX_K) {
      gpu = await EmGpu.create(p.data);
    }
    if (cancelled.has(id)) {
      return;
    }

    const n = p.data.length / 2;
    let params: Mixture2D = initialGuess2d(p.data, p.k, mulberry32(p.seed));
    const trace: number[] = [];
    let last: EmProgress | undefined;

    for (let iter = 1; iter <= p.iterations; iter++) {
      let step: { params: Mixture2D; logLik: number };
      if (gpu !== null) {
        try {
          const sums = await gpu.eStep(params);
          step = { params: mStepFromSums(params, n, sums), logLik: sums.logLik };
        } catch {
          // Device lost mid-run: finish honestly on JS.
          gpu.destroy();
          gpu = null;
          step = emStep2d(p.data, params);
        }
      } else {
        step = emStep2d(p.data, params);
      }
      params = step.params;
      trace.push(step.logLik);
      post({ id, type: "progress", value: iter / p.iterations });

      const progress: EmProgress = {
        iter,
        params,
        logLik: step.logLik,
        trace: trace.slice(),
        backend: gpu !== null ? "webgpu" : "js",
      };
      if (iter === p.iterations) {
        last = progress;
        break;
      }
      post({ id, type: "partial", value: progress });

      await (p.frameMs > 0 ? pause(p.frameMs) : macrotask());
      if (cancelled.has(id)) {
        return;
      }
    }
    if (last !== undefined) {
      post({ id, type: "done", value: last });
    }
  } catch (err) {
    post({ id, type: "error", message: err instanceof Error ? err.message : String(err) });
  } finally {
    gpu?.destroy();
    cancelled.delete(id);
  }
}
