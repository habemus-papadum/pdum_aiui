/**
 * gestures.ts — scroll INTENT, as pure state machines: continuous input
 * (wheel deltas, touch travel) in, discrete steps (−1 | 0 | +1) out.
 *
 * The deck's unit of navigation is the STEP (one scene advance, or one slide
 * when the scenes are spent — model.ts), so raw input must be quantized: a
 * flick, a wheel notch, or a deliberate two-finger drag each mean ONE step,
 * no matter how many events the hardware emits. The hard case is trackpad
 * inertia — one flick produces a decaying tail of events lasting a second or
 * more, and a naïve accumulator would blow through five steps. The machines
 * here are realm-free (no DOM, no Date) and take timestamps as arguments, so
 * every rule below is pinned by unit tests (gestures.test.ts).
 *
 * ## Wheel: one gesture, one step
 *
 * A GESTURE is a burst of events. Within a gesture, deltas accumulate until
 * they cross `threshold` — that emits the step and consumes the gesture;
 * everything after (the inertia tail) is swallowed. A new gesture begins on:
 *
 *  - a QUIET GAP (`quietMs` without events — the tail ended, fingers lifted);
 *  - a DIRECTION FLIP (the user reversed; intent is unambiguous);
 *  - a RE-FLICK SPIKE: a delta far above the recent tail (`boost` × the
 *    largest of the last few magnitudes) is fresh finger acceleration, not
 *    inertia — this is what lets an eager user step twice without waiting
 *    out the tail. Inertia decays; only a new flick accelerates.
 *
 * ## Touch: one finger-down, one step
 *
 * Travel from the touch start; crossing `threshold` px emits and consumes.
 * The next step needs a new touch — matching the wheel's one-gesture-one-step
 * contract exactly (a long slow drag is still one gesture).
 *
 * Normalization (line/page delta modes → px) is the event handler's job
 * (deck.tsx); these machines speak pixels only.
 */

/** One discrete navigation impulse: −1 back, +1 forward, 0 nothing yet. */
export type GestureStep = -1 | 0 | 1;

export interface WheelIntentOptions {
  /** Accumulated px that mean "one step" (default 60). */
  threshold?: number;
  /** Event gap that ends a gesture (default 150 ms — inertia tails emit
   * faster than this until they truly die). */
  quietMs?: number;
  /** Re-flick detector: a delta this many times the recent maximum is a new
   * gesture even mid-tail (default 2). */
  boost?: number;
  /** Ignore re-flick spikes below this magnitude — late-tail jitter between
   * tiny values must not qualify (default 10 px). */
  boostMin?: number;
}

export interface WheelIntent {
  /** Feed one wheel event (`now` in ms, `delta` in px, + = forward/down). */
  feed(now: number, delta: number): GestureStep;
}

export function createWheelIntent(options: WheelIntentOptions = {}): WheelIntent {
  const threshold = options.threshold ?? 60;
  const quietMs = options.quietMs ?? 150;
  const boost = options.boost ?? 2;
  const boostMin = options.boostMin ?? 10;

  let lastTime = Number.NEGATIVE_INFINITY;
  let accum = 0; // signed sum for the current gesture (frozen once consumed)
  let consumed = false;
  let recent: number[] = []; // last few magnitudes, the tail's fingerprint

  return {
    feed(now, delta): GestureStep {
      if (delta === 0) return 0;
      const gap = now - lastTime;
      lastTime = now;
      const mag = Math.abs(delta);
      const flipped = accum !== 0 && Math.sign(delta) !== Math.sign(accum);
      const spike =
        consumed && mag >= boostMin && recent.length > 0 && mag > boost * Math.max(...recent);
      if (gap > quietMs || flipped || spike) {
        accum = 0;
        consumed = false;
        recent = [];
      }
      recent.push(mag);
      if (recent.length > 4) recent.shift();
      if (consumed) return 0;
      accum += delta;
      if (Math.abs(accum) < threshold) return 0;
      consumed = true;
      // The tail fingerprint starts HERE: the ramp that produced this step
      // must not set the re-flick bar (its peak would mask a genuine second
      // flick), so the spike detector compares against post-step tail only.
      recent = [];
      return accum > 0 ? 1 : -1;
    },
  };
}

export interface TouchIntentOptions {
  /** Finger travel (px) that means "one step" (default 48). */
  threshold?: number;
}

export interface TouchIntent {
  /** A single-finger touch began at `y` (client px). */
  start(y: number): void;
  /** The finger moved to `y`; may emit the gesture's one step. Finger moving
   * UP (content pushed up) is forward — the scroll convention. */
  move(y: number): GestureStep;
  /** The finger lifted (or the touch was cancelled); the next step needs a
   * fresh touch. */
  end(): void;
}

export function createTouchIntent(options: TouchIntentOptions = {}): TouchIntent {
  const threshold = options.threshold ?? 48;
  let startY: number | null = null;
  let consumed = false;
  return {
    start(y) {
      startY = y;
      consumed = false;
    },
    move(y): GestureStep {
      if (startY === null || consumed) return 0;
      const travel = startY - y;
      if (Math.abs(travel) < threshold) return 0;
      consumed = true;
      return travel > 0 ? 1 : -1;
    },
    end() {
      startY = null;
      consumed = false;
    },
  };
}
