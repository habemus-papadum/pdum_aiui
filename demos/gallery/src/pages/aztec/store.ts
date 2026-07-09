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
 * This is a Level-1 notebook page (PRINCIPLES §8): its own entry, its own fresh
 * window, hence its own durable registry and its own agent-tool namespace
 * (window.__aztec) — nothing here can collide with morphogen.
 */
import { durable, durableSignal } from "@habemus-papadum/aiui-viz";
import { type Accessor, createSignal } from "solid-js";
import type { ShuffleFrame } from "./types";

/** Side of the square canvas, in device pixels. */
export const CANVAS_PX = 720;
/** Never retain more than this many frames (memory cap for the scrub ring). */
export const MAX_FRAMES = 240;
export const MAX_N = 96;

const randomSeed = () => (Math.random() * 0xffffffff) >>> 0;

// --- controls (durable interaction state) -----------------------------------

export const targetN = durableSignal("aztec:targetN", 32);
export const seed = durableSignal<number>("aztec:seed", randomSeed());
export const playing = durableSignal("aztec:playing", true);
export const fps = durableSignal("aztec:fps", 8);
export const showCircle = durableSignal("aztec:showCircle", true);
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

export const aztecCanvas: HTMLCanvasElement = durable("aztec:canvas", () => {
  const canvas = document.createElement("canvas");
  canvas.width = CANVAS_PX;
  canvas.height = CANVAS_PX;
  canvas.className = "aztec-canvas";
  return canvas;
});

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
  dispose(): void;
}

export const player: Player = durable("aztec:player", () => {
  let raf = 0;
  let last = performance.now();
  let acc = 0;
  let disposed = false;

  const tick = (now: number) => {
    if (disposed) return;
    const dt = now - last;
    last = now;
    if (playing.get()) {
      acc += dt;
      const interval = 1000 / Math.max(1, fps.get());
      const edge = frames.frames.length - 1;
      while (acc >= interval) {
        acc -= interval;
        const cur = frameIndex.get();
        if (cur < edge) frameIndex.set(cur + 1);
        else {
          acc = 0;
          break;
        }
      }
    } else {
      acc = 0;
    }
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return {
    dispose() {
      disposed = true;
      cancelAnimationFrame(raf);
    },
  };
});
