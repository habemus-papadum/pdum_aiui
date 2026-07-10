/**
 * loop.ts — the render loop, and the one-way bridge from the imperative sim
 * island into the reactive graph.
 *
 * The rAF hot path never touches signals. On a slow cadence (~4 Hz) it reads
 * the field back, reduces it to a small Snapshot, and publishes that through
 * `onSnapshot` — which the model turns into a signal write. That cadence
 * boundary is a deliberate pattern: reactive consumers get values at the rate
 * they can usefully absorb, and the 60 Hz world stays imperative.
 *
 * The loop also keeps simple health counters (fps, cadence) that feed the HUD
 * and `window.__morpho.report()` — instrument the seams, per
 * archive/agentic_ui_workflow/agentic_frontend_debugging.md.
 */
import type { GrayScottEngine } from "./gray-scott";
import { computeFieldStats, type FieldStats } from "./stats";

export interface Snapshot extends FieldStats {
  /** ms epoch when the snapshot was taken. */
  t: number;
  /** Simulation steps taken since the last seed. */
  steps: number;
}

export interface LoopOptions {
  engine: GrayScottEngine;
  onSnapshot: (snap: Snapshot) => void;
  snapshotEveryMs?: number;
}

export interface SimLoop {
  /** Steps per frame; 0 pauses the simulation (rendering continues). */
  setSpeed(stepsPerFrame: number): void;
  speed(): number;
  /** Copy the current field (V channel as floats) for heavy analysis. */
  captureField(): { field: Float32Array; width: number; height: number };
  stats(): { fps: number; stepsPerSecond: number; snapshotAgeMs: number };
  /**
   * Park the rAF loop entirely — no stepping, no present, no readback — while
   * keeping the engine and its accrued field intact. The SPA shell calls this
   * when the route leaves the page (pause-not-destroy: a hidden notebook must
   * not burn GPU); `resume` picks the loop back up where it stood. Distinct
   * from `speed = 0`, which is the USER's pause and keeps rendering.
   */
  pause(): void;
  resume(): void;
  running(): boolean;
  dispose(): void;
}

export function startLoop(options: LoopOptions): SimLoop {
  const { engine } = options;
  const snapshotEvery = options.snapshotEveryMs ?? 250;
  let speed = 12;
  let raf = 0;
  let lastSnapshot = 0;
  let frames = 0;
  let fps = 0;
  let stepsPerSecond = 0;
  let windowStart = performance.now();
  let stepsInWindow = 0;
  let disposed = false;
  let paused = false;

  const frame = (now: number) => {
    if (disposed || paused) return;
    if (speed > 0) {
      engine.step(speed);
      stepsInWindow += speed;
    }
    engine.present();
    frames++;
    if (now - windowStart >= 1000) {
      fps = (frames * 1000) / (now - windowStart);
      stepsPerSecond = (stepsInWindow * 1000) / (now - windowStart);
      frames = 0;
      stepsInWindow = 0;
      windowStart = now;
    }
    if (now - lastSnapshot >= snapshotEvery) {
      lastSnapshot = now;
      const bytes = engine.readback();
      options.onSnapshot({
        t: Date.now(),
        steps: engine.steps,
        ...computeFieldStats(bytes, engine.size, engine.size),
      });
    }
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);

  return {
    setSpeed(s) {
      speed = Math.max(0, Math.round(s));
    },
    speed: () => speed,
    captureField() {
      const bytes = engine.readback();
      const n = engine.size * engine.size;
      const field = new Float32Array(n);
      for (let i = 0; i < n; i++) field[i] = bytes[i * 4 + 1] / 255; // V channel
      return { field, width: engine.size, height: engine.size };
    },
    stats: () => ({
      fps: Math.round(fps),
      stepsPerSecond: Math.round(stepsPerSecond),
      snapshotAgeMs: Math.round(performance.now() - lastSnapshot),
    }),
    pause() {
      if (paused || disposed) return;
      paused = true;
      cancelAnimationFrame(raf);
    },
    resume() {
      if (!paused || disposed) return;
      paused = false;
      // Reset the fps window so the idle stretch doesn't read as 0 fps.
      windowStart = performance.now();
      frames = 0;
      stepsInWindow = 0;
      raf = requestAnimationFrame(frame);
    },
    running: () => !paused && !disposed,
    dispose() {
      disposed = true;
      cancelAnimationFrame(raf);
    },
  };
}
