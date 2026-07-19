/**
 * store.ts — the durable roots (playbook layer 2, state side) and the control
 * surface for the circle-drawing meter.
 *
 * The one genuinely durable, imperative object here is the {@link paper}: a
 * `PencilSurface` from `@habemus-papadum/aiui-pencil`, with **vanishing ink** —
 * a stroke fades and pops a few seconds after you lift the pen. It is a
 * `durable()` so a hot edit to a component never wipes what you just drew.
 *
 * A **turn** begins the instant a new stroke starts. Its whole lifecycle is
 * three durable signals the surface's own callbacks drive:
 *
 *   onStrokeStart → phase "drawing", frozen points cleared   (a NEW turn: reset)
 *   …pen moves…   → live points flow through `ink.live()`     (stats update live)
 *   onStrokeEnd   → phase "settled", the final points frozen  (stats FREEZE)
 *
 * The freeze is the point: the ink vanishes on the surface's fade clock, but
 * `frozenPoints` is never touched by the fade, so the measured statistics stay
 * on screen until the next stroke resets them. See `graph.ts` for the `stats`
 * cell that reads {@link turnPoints}.
 */

import {
  inkSignals,
  type PencilParams,
  PencilSurface,
  type PenSample,
  SKETCH,
} from "@habemus-papadum/aiui-pencil";
import { control, durable, durableSignal } from "@habemus-papadum/aiui-viz";
import { CenterGhost } from "./center-ghost";
import { summarize, type Vec } from "./circle";

// ── the control surface ──────────────────────────────────────────────────────

/** How long the ink lingers before it fades and pops, in seconds. The measured
 * statistics stay after the ink is gone; only a new stroke resets them. */
export const fadeSeconds = control({ value: 6, min: 1, max: 15, step: 0.5, unit: " s" });

/** Nominal pencil radius, px — the thickness of the line you draw with. */
export const brushSize = control({ value: 3.2, min: 1, max: 8, step: 0.2, unit: "px" });

/**
 * How much the app helps while you draw — the difficulty of the exercise.
 *  - `guide`: the best-fit circle, ellipse, and centre track your stroke live
 *    (easy — but you can cheat by tracing the preview).
 *  - `zen`: only the fitted CENTRE is shown while you draw, as a ghosting dot;
 *    the full shape is revealed when you lift. Focus on the centre.
 *  - `blind`: no guide at all until you lift, then the fit is revealed.
 */
export const guideMode = control<"guide" | "zen" | "blind">({
  value: "guide",
  options: ["guide", "zen", "blind"],
});

// ── the turn: three signals the surface drives ───────────────────────────────

/** Where the current turn is: nothing drawn yet, mid-stroke, or a finished
 * stroke whose statistics are frozen on screen. */
export type TurnPhase = "idle" | "drawing" | "settled";

/** The current turn's phase. */
export const turnPhase = durableSignal<TurnPhase>("circle:phase", "idle");

/** The finished stroke's points, frozen at pen-up and held past the ink fade.
 * Empty while drawing (the live points come from `ink.live()` instead). */
export const frozenPoints = durableSignal<readonly PenSample[]>("circle:frozen", []);

/** How many strokes have been drawn this session — a turn counter for the UI. */
export const turnCount = durableSignal<number>("circle:turns", 0);

/** The most recent measured turn scores, oldest → newest, capped at this many —
 * the sparkline's data. Survives a `clear` (it is a session log, not the
 * current stroke). */
export const HISTORY_LEN = 20;
export const scoreHistory = durableSignal<readonly number[]>("circle:history", []);

/** Append a settled turn's score to the history ring, dropping the oldest past
 * {@link HISTORY_LEN}. A stroke too short to measure (summarize → null) is not a
 * turn and is not recorded. Called on pen-up; exported so it is unit-testable
 * without a live surface. */
export function recordTurn(points: readonly Vec[]): void {
  const measured = summarize(points);
  if (measured !== null) {
    scoreHistory.set((h) => [...h, measured.score].slice(-HISTORY_LEN));
  }
}

// ── the instrument ───────────────────────────────────────────────────────────

/** The pencil the surface draws with — SKETCH dynamics (smooth arcs, corners
 * kept loose) in a warm red that reads on the dark ground, sized by the
 * `brushSize` control. Read PER STROKE START, so a stroke keeps its brush even
 * if the slider moves mid-draw. */
export function currentParams(): PencilParams {
  return { ...SKETCH, size: brushSize.get(), color: "#ff6b6b" };
}

/**
 * The drawing surface itself — the three-tier `PencilSurface` with vanishing
 * ink. Constructed against `document.body`; the drawing component re-parents
 * its canvas into the stage and calls `setActive(true)` so it owns the pointer.
 *
 * The turn lifecycle lives entirely in these two callbacks — no separate
 * recorder, because the surface is already the one place a stroke's points are
 * captured (`onStrokeEnd` hands us the committed samples).
 */
export const paper = durable(
  "circle:paper",
  () =>
    new PencilSurface({
      className: "circle-paper",
      params: () => currentParams(),
      fadeSec: () => fadeSeconds.get(),
      // Transparent: the page's dark ground shows through, ink floats on it.
      background: () => undefined,
      onStrokeStart: () => {
        // One mark at a time: the previous stroke clears the instant a new one
        // begins. `clearCompleted` drops the finished/fading strokes but leaves
        // THIS just-begun stroke (already in the live set) untouched — a plain
        // clear() here would wipe it. (Idle strokes still fade on their own via
        // fadeSec; this only makes a *new* stroke replace the last at once.)
        paper.clearCompleted();
        // A new stroke IS a new turn: bump the counter, drop the last turn's
        // frozen stats, and enter the live phase.
        turnCount.set((n) => n + 1);
        frozenPoints.set([]);
        turnPhase.set("drawing");
      },
      onStrokeEnd: (end) => {
        // Pen up: freeze the final points (they outlive the ink's fade) and log
        // this turn's score to the history ring behind the sparkline.
        frozenPoints.set(end.points);
        turnPhase.set("settled");
        recordTurn(end.points);
      },
    }),
);

/**
 * The drawing as Solid signals: `ink.strokes()` (committed, immediate) and
 * `ink.live()` (the in-flight stroke, cumulative points at ~15 Hz — lossless).
 * The `stats` cell reads `live()` during the drawing phase.
 */
export const ink = durable("circle:ink", () => inkSignals(paper));

/**
 * The Zen guide's centre-ghost renderer (imperative rAF island). It reads the
 * live stroke's points STRAIGHT from the surface every frame — not through the
 * throttled `ink.live()` — so the focus dot tracks at 60 Hz, not 15. A
 * component adopts its canvas and arms/disarms it by mode + phase.
 */
export const centerGhost = durable(
  "circle:centerGhost",
  () =>
    new CenterGhost({
      source: () => {
        const live = paper.ink().live;
        return live.length > 0 ? live[live.length - 1].points : [];
      },
    }),
);

/**
 * The points the statistics are measured over RIGHT NOW: the live stroke while
 * drawing, the frozen stroke once settled. Reads three signals, so a cell whose
 * deps call this recomputes as the pen moves and again when the stroke settles.
 */
export function turnPoints(): readonly PenSample[] {
  if (turnPhase.get() === "drawing") {
    const live = ink.live();
    return live.length > 0 ? live[live.length - 1].points : frozenPoints.get();
  }
  return frozenPoints.get();
}

/** Reset the turn to idle with no measured stroke — the clear button and the
 * `clear` agent action both call this after wiping the surface. The score
 * history is deliberately NOT cleared (it is a running log across clears). */
export function resetTurn(): void {
  frozenPoints.set([]);
  turnPhase.set("idle");
}
