/**
 * use-spin.ts — a self-managing rAF rotation island, PARKED when its gate
 * closes: the pause-not-destroy discipline at slide granularity. A slide
 * passes `() => useSlide().active(-ish) && …` as the gate; off-screen (or
 * paused) the loop is cancelled, the angle keeps its value, and re-opening
 * the gate resumes from exactly there.
 */
import { type Accessor, createEffect, createSignal, onCleanup } from "solid-js";

/** A continuously integrated angle (radians). `rate` is rad/s, read fresh
 * every frame (a control-backed rate takes effect immediately). */
export function useSpin(rate: () => number, gate: () => boolean): Accessor<number> {
  const [theta, setTheta] = createSignal(0);
  let raf = 0;
  let last = 0;
  const loop = (now: number): void => {
    raf = requestAnimationFrame(loop);
    const dt = last === 0 ? 0 : (now - last) / 1000;
    last = now;
    if (dt > 0) setTheta((t) => t + rate() * dt);
  };
  createEffect(gate, (on) => {
    if (on && raf === 0 && typeof requestAnimationFrame !== "undefined") {
      last = 0;
      raf = requestAnimationFrame(loop);
    } else if (!on && raf !== 0) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
  });
  onCleanup(() => {
    if (raf !== 0) cancelAnimationFrame(raf);
  });
  return theta;
}
