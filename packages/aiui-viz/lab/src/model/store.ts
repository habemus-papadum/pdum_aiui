/** Durable roots and the control surface of the RichTeX lab. */

import { control, scope } from "@habemus-papadum/aiui-viz";
import { MAX_HARMONICS } from "./fourier";
import { STEPS } from "./quadratic";
import { initialStep, stepTraining, type TrainStep } from "./training";

export const labScope = scope("rich-tex-lab");

// ── training: the fake run and its knobs ────────────────────────────────────

/** Run the (fake) training loop. Off = paused; the step counter holds. */
export const playing = control({ scope: labScope, value: true });

/** Steps per second — how fast the terms breathe. */
export const speed = control({
  scope: labScope,
  value: 12,
  min: 1,
  max: 60,
  step: 1,
  unit: " steps/s",
});

/** The KL coefficient β. Raise it and the KL term shrinks as the penalty bites. */
export const beta = control({ scope: labScope, value: 0.1, min: 0, max: 0.5, step: 0.01 });

/** The clip half-width ε: the band [1 − ε, 1 + ε]. Widen it and fewer samples clip. */
export const epsilon = control({ scope: labScope, value: 0.2, min: 0.02, max: 0.6, step: 0.01 });

/** The value-error coefficient c_v. */
export const cv = control({ scope: labScope, value: 0.5, min: 0, max: 1.5, step: 0.05 });

/** The entropy-bonus coefficient c_H. */
export const ch = control({ scope: labScope, value: 0.05, min: 0, max: 0.3, step: 0.005 });

export const LENSES = ["magnitude", "clipping", "gradient"] as const;
export type Lens = (typeof LENSES)[number];

/**
 * Which family of annotations the training equation shows — one at a time,
 * so the line stays legible: `magnitude` (each term's share of the loss),
 * `clipping` (inside the surrogate: which argument the min takes, which
 * bound clips), `gradient` (each term's pull and whether it helps the step).
 */
export const lens = control<Lens>({ scope: labScope, value: "magnitude", options: LENSES });

/** The equation's parameters as the dynamics take them, read at the moment of use. */
export const params = () => ({
  beta: beta.get(),
  epsilon: epsilon.get(),
  cv: cv.get(),
  ch: ch.get(),
});

/** The run so far, newest last — the render mirror of the trainer's history. */
export const train = labScope.durableSignal<readonly TrainStep[]>("train", [initialStep()]);

const HISTORY = 600;

export interface Trainer {
  start(hz: number): void;
  stop(): void;
  reset(): void;
}

/**
 * The run's AUTHORITY: a plain array in a durable box, advanced by an interval
 * and published to `train` as a fresh array each step. (Solid 2.0 stages
 * writes — `set(f(get()))` from a timer reads a stale base — so the history
 * never lives in the signal; the signal is a mirror.)
 */
export const trainer = labScope.durable<Trainer>("trainer", () => {
  let history: TrainStep[] = [initialStep()];
  let timer: ReturnType<typeof setInterval> | undefined;
  const publish = () => train.set(history.slice());
  const stop = () => {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
  };
  return {
    start(hz) {
      stop();
      timer = setInterval(
        () => {
          const last = history[history.length - 1] ?? initialStep();
          history = [...history.slice(-(HISTORY - 1)), stepTraining(last, params())];
          publish();
        },
        Math.max(16, 1000 / hz),
      );
    },
    stop,
    reset() {
      history = [initialStep()];
      publish();
    },
  };
});

// ── derivation: which step, and the coefficients ────────────────────────────

/** Which step of the derivation is on screen (0 = the start). */
export const step = control({ scope: labScope, value: 0, min: 0, max: STEPS.length - 1, step: 1 });

/** The quadratic's a. */
export const qa = control({ scope: labScope, value: 1, min: 0.5, max: 3, step: 0.1 });
/** The quadratic's b. */
export const qb = control({ scope: labScope, value: -3, min: -6, max: 6, step: 0.5 });
/** The quadratic's c. */
export const qc = control({ scope: labScope, value: 1, min: -6, max: 4, step: 0.5 });

// ── fourier: how many harmonics, and which are muted ────────────────────────

/** Number of harmonics in the partial sum. */
export const harmonics = control({
  scope: labScope,
  value: 4,
  min: 1,
  max: MAX_HARMONICS,
  step: 1,
});

/** The muted harmonics (by k), as a render mirror of the box below. */
export const muted = labScope.durableSignal<readonly number[]>("muted", []);
const mutedBox = labScope.durable("muted-box", () => new Set<number>());

/** Toggle one harmonic in or out of the sum. Returns the new state. */
export function toggleMuted(k: number): boolean {
  if (mutedBox.has(k)) mutedBox.delete(k);
  else mutedBox.add(k);
  muted.set([...mutedBox].sort((x, y) => x - y));
  return mutedBox.has(k);
}
