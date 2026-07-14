/**
 * store.ts — the durable roots of the aztec page (playbook layer 2, state side).
 *
 * Everything here survives a hot edit: the user's controls (target order,
 * animation speed, circle toggle — interaction state), the canvas the tiling is
 * painted on, the ring of streamed growth frames (so you can scrub the fold
 * back and forth), the shuffle worker, and the animation player (a rAF loop
 * that walks the playhead through the ring at the chosen speed). The cell graph
 * (graph.ts) and components (ui/) are the disposable logic rebuilt over these.
 *
 * Under the SPA shell all notebooks share ONE window, so collision avoidance
 * is a naming discipline, not an accident of separate documents: durable keys
 * carry the `aztec:` prefix, control/cell names must be unique app-wide (the
 * registries are global), and the agent-tool namespace stays window.__aztec.
 */
import { control, durable, durableCanvas, durableSignal } from "@habemus-papadum/aiui-viz";
import { type Accessor, createSignal } from "solid-js";
import type { ShuffleFrame } from "./types";

/** Side of the square canvas, in device pixels. */
export const CANVAS_PX = 720;
/** Never retain more than this many frames (memory cap for the scrub ring). */
export const MAX_FRAMES = 240;
export const MAX_N = 96;

const randomSeed = () => (Math.random() * 0xffffffff) >>> 0;

// --- the control surface (described, constrained, agent-settable) ------------
//
// Names and the descriptions below are compiler-injected (the doc comment IS
// the registry description). `seed`, `runId`, and `frameIndex` stay
// durableSignals: they are derived/playhead state, not knobs a human drags —
// the surface is curated.

/** Target Aztec-diamond order n; changing it regrows to that size. */
export const targetN = control({ value: 32, min: 1, max: MAX_N, step: 1 });

/** Whether the growth animation is running. */
export const playing = control({ value: true });

/** Animation speed, growth-frames per second. */
export const fps = control({ value: 8, min: 1, max: 60, step: 1 });

/** Show the theoretical arctic-circle overlay. */
export const showCircle = control({ value: true });

export const seed = durableSignal<number>("aztec:seed", randomSeed());
/** Bumped to force a fresh run (regrow) without changing target/seed. */
export const runId = durableSignal("aztec:runId", 0);
/** The playhead: which ring frame is currently painted. */
export const frameIndex = durableSignal("aztec:frameIndex", 0);

/** Grow a fresh random tiling from a new seed. */
export function regrow(): number {
  const s = randomSeed();
  seed.set(s);
  return s;
}

// --- the growth-frame ring (durable structure + version signal) --------------

export interface FrameRing {
  frames: ShuffleFrame[];
  version: Accessor<number>;
  push(f: ShuffleFrame): void;
  clear(): void;
  at(i: number): ShuffleFrame | undefined;
  last(): ShuffleFrame | undefined;
}

export const frames: FrameRing = durable("aztec:frames", () => {
  const [version, setVersion] = createSignal(0);
  const rows: ShuffleFrame[] = [];
  return {
    frames: rows,
    version,
    push(f) {
      rows.push(f);
      if (rows.length > MAX_FRAMES) rows.splice(0, rows.length - MAX_FRAMES);
      setVersion((v) => v + 1);
    },
    clear() {
      rows.length = 0;
      setVersion((v) => v + 1);
    },
    at: (i) => rows[i],
    last: () => rows[rows.length - 1],
  };
});

// --- the durable canvas island (adopted by AztecCanvas) ----------------------

export const aztecSurface = durableCanvas("aztec:canvas", (canvas) => {
  canvas.width = CANVAS_PX;
  canvas.height = CANVAS_PX;
  canvas.className = "aztec-canvas";
});

/** The element itself — what the tiling is painted into. */
export const aztecCanvas: HTMLCanvasElement = aztecSurface.canvas;

export const ctx2d: CanvasRenderingContext2D = durable("aztec:ctx", () => {
  const c = aztecCanvas.getContext("2d");
  if (!c) throw new Error("aztec: 2D canvas context unavailable");
  return c;
});

// --- the shuffle worker (durable resource) -----------------------------------

export const shuffleWorker: Worker = durable(
  "aztec:worker",
  () => new Worker(new URL("./shuffle.worker.ts", import.meta.url), { type: "module" }),
);

// --- the animation player (durable rAF loop → frameIndex) --------------------
//
// The imperative island: a rAF loop that, while playing, advances the playhead
// toward the ring's leading edge at `fps`. During a live run the edge keeps
// growing, so playback "watches the fold" unfold; once caught up it simply
// holds. Writes to frameIndex happen in the rAF callback (no owned scope), the
// same one-way cadence bridge as morphogen's snapshot loop.

export interface Player {
  /**
   * Park the rAF loop while the SPA shell has this page off-route
   * (pause-not-destroy: a hidden notebook must not tick). Distinct from the
   * `playing` control, which is the USER's pause and keeps the loop alive.
   */
  pause(): void;
  resume(): void;
  dispose(): void;
}

export const player: Player = durable("aztec:player", () => {
  let raf = 0;
  let last = performance.now();
  let acc = 0;
  let disposed = false;
  let paused = false;

  const tick = (now: number) => {
    if (disposed || paused) return;
    const dt = now - last;
    last = now;
    if (playing.get()) {
      acc += dt;
      const interval = 1000 / Math.max(1, fps.get());
      const edge = frames.frames.length - 1;
      // Track the playhead in a LOCAL across the drain: a rAF tick is an
      // imperative boundary, so re-reading frameIndex after set() serves the
      // pre-write value — the loop drained acc but advanced at most one frame
      // per tick (silently slow at high fps or after any stutter).
      let cur = frameIndex.get();
      while (acc >= interval) {
        acc -= interval;
        if (cur < edge) cur += 1;
        else {
          acc = 0;
          break;
        }
      }
      frameIndex.set(cur);
    } else {
      acc = 0;
    }
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return {
    pause() {
      if (paused || disposed) return;
      paused = true;
      cancelAnimationFrame(raf);
    },
    resume() {
      if (!paused || disposed) return;
      paused = false;
      last = performance.now(); // don't replay the idle stretch as elapsed time
      acc = 0;
      raf = requestAnimationFrame(tick);
    },
    dispose() {
      disposed = true;
      cancelAnimationFrame(raf);
    },
  };
});
