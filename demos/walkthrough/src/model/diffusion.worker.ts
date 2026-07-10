/**
 * diffusion.worker.ts — the seam between layers 1 and 2: a THIN shell speaking
 * the aiui-viz worker protocol around the pure math in ../lib/diffusion. No
 * physics lives here (it would escape the headless-testable layer); no
 * framework code either (`import type` from the barrel is fully erased, so
 * this bundle never drags solid-js in).
 *
 * The choreography the hard-won ledger prescribes: chunk the march, yield a
 * REAL macrotask between chunks (`setTimeout 0` — a micro-yield never lets the
 * `cancel` message be delivered), post `progress` per chunk, stream cumulative
 * `partial` snapshots as rows of the space-time picture accumulate, and let
 * `done` carry the final payload alone (a value posted as both partial and
 * done double-counts in any accumulating consumer).
 */
import type { WorkerReply, WorkerRequest } from "@habemus-papadum/aiui-viz";
import { diffusionStep, type InitialCondition, initialProfile, stableDt } from "../lib/diffusion";

/** What the evolution cell sends down. */
export interface EvolutionParams {
  kappa: number;
  n: number;
  ic: InitialCondition;
  seed: number;
  simTime: number;
  frames: number;
}

/** One captured snapshot: the profile at time t. */
export interface Frame {
  t: number;
  u: Float64Array;
}

/** The streamed value: every frame captured so far (cumulative). */
export interface Evolution {
  frames: Frame[];
  /** Physical duration represented (the last frame's t). */
  t: number;
}

const cancelled = new Set<number>();

self.onmessage = (e: MessageEvent<WorkerRequest<EvolutionParams>>) => {
  const msg = e.data;
  if (msg.type === "cancel") {
    cancelled.add(msg.id);
    return;
  }
  if (msg.type === "run") {
    void run(msg.id, msg.payload);
  }
};

const post = (reply: WorkerReply<Evolution>) => self.postMessage(reply);

async function run(id: number, p: EvolutionParams): Promise<void> {
  const dx = 1 / (p.n - 1);
  const dt = 0.9 * stableDt(p.kappa, dx); // a safe margin under the r = ½ limit
  const r = (p.kappa * dt) / (dx * dx);
  const steps = Math.max(1, Math.round(p.simTime / dt));
  const perFrame = Math.max(1, Math.floor(steps / p.frames));

  let u: Float64Array = initialProfile(p.ic, p.n, p.seed);
  let scratch: Float64Array = new Float64Array(p.n);
  const frames: Frame[] = [{ t: 0, u: u.slice() }];

  for (let s = 1; s <= steps; s++) {
    diffusionStep(u, r, scratch);
    [u, scratch] = [scratch, u];
    if (s % perFrame === 0 || s === steps) {
      frames.push({ t: s * dt, u: u.slice() });
      post({ id, type: "progress", value: s / steps });
      // Stream the picture as it grows — every 8th row, so the copies stay
      // cheap while the heatmap visibly fills in.
      if (frames.length % 8 === 0 && s !== steps) {
        post({ id, type: "partial", value: { frames: frames.slice(), t: s * dt } });
      }
      // The macrotask yield: THIS is what lets `cancel` be delivered.
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (cancelled.has(id)) {
        cancelled.delete(id);
        return;
      }
    }
  }
  post({ id, type: "done", value: { frames, t: steps * dt } });
}
