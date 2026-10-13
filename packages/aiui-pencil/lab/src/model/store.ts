/**
 * store.ts — Pencil Lab's durable roots and its control surface.
 *
 * Every knob of the instrument is a `control()`, which means all of them are
 * simultaneously: a slider, a keyboard-writable value, a durable that survives
 * hot edits, and **an agent-facing parameter** — so Claude can tune the pencil
 * too ("make the grain finer and show me" is the loop this repo exists for).
 *
 * The numbers here start at the `WRITE` preset from `aiui-pencil`. The Lab's
 * whole purpose is to discover better ones by *drawing*, after which the winners
 * are written back into `pencil.ts` as the shipped presets. That is the
 * direction of travel: the Lab is upstream of the library's defaults, not a
 * consumer of them.
 *
 * The one thing that is NOT a control is the pen recorder — an imperative object
 * that must never appear in the reactive graph's hot path (it sees 120+ samples
 * a second). It is a `labScope.durable()`, it is plain, and it publishes into signals on
 * its own slow schedule. See `capture.ts`.
 */

import {
  inkSignals,
  type PencilMode,
  type PencilParams,
  PencilSurface,
  type Tool,
  WRITE,
} from "@habemus-papadum/aiui-pencil";
import { control, scope, throttled } from "@habemus-papadum/aiui-viz";
import { PenRecorder } from "./capture";
import { PadRenderer } from "./pad-renderer";

export const labScope = scope("pencil-lab");

// ── which preset to load (loading is an action; see graph.ts) ────────────────

/** The preset the "load preset" action copies into the knobs below. */
export const preset = control<PencilMode>({
  scope: labScope,
  value: "write",
  options: ["write", "sketch", "auto"],
});

// ── conditioning: what happens to the points before anything is drawn ────────

/** One-Euro floor cutoff (Hz). Lower = a stiller still pen, and more lag. The jitter knob. */
export const minCutoff = control({
  scope: labScope,
  value: WRITE.filter.minCutoff,
  min: 0.1,
  max: 5,
  step: 0.05,
  unit: " Hz",
});

/** One-Euro speed coefficient. Higher = the filter gets out of a fast pen's way. The lag knob. */
export const beta = control({
  scope: labScope,
  value: WRITE.filter.beta,
  min: 0,
  max: 3,
  step: 0.05,
});

/** How hard a turn counts as a corner the spline must NOT smooth through. */
export const cuspAngle = control({
  scope: labScope,
  value: Math.round((WRITE.cuspThreshold * 180) / Math.PI),
  min: 20,
  max: 170,
  step: 5,
  unit: "°",
});

/** How far along the stroke to look when judging a corner. Too small and jitter reads as corners. */
export const cuspWindow = control({
  scope: labScope,
  value: WRITE.cuspWindow,
  min: 1,
  max: 20,
  step: 0.5,
  unit: "px",
});

// ── the mark ────────────────────────────────────────────────────────────────

/** Nominal dab radius — the mark of an upright pen at full pressure. */
export const size = control({
  scope: labScope,
  value: WRITE.size,
  min: 0.4,
  max: 8,
  step: 0.1,
  unit: "px",
});

/** Dab spacing, as a fraction of dab radius. Below ~0.25 the stroke reads as solid. */
export const spacing = control({
  scope: labScope,
  value: WRITE.spacing,
  min: 0.05,
  max: 0.6,
  step: 0.01,
});

/** Base opacity of one dab, before any dynamics. The graphite's darkness. */
export const flow = control({ scope: labScope, value: WRITE.flow, min: 0.05, max: 1, step: 0.01 });

// ── dynamics ────────────────────────────────────────────────────────────────

/** Dab radius at ZERO pressure, as a fraction of full. The taper of a light touch. */
export const pressureRadiusFloor = control({
  scope: labScope,
  value: WRITE.pressureToRadius[0],
  min: 0.05,
  max: 1,
  step: 0.05,
});

/** Dab opacity at ZERO pressure, as a fraction of full. */
export const pressureAlphaFloor = control({
  scope: labScope,
  value: WRITE.pressureToAlpha[0],
  min: 0,
  max: 1,
  step: 0.05,
});

/**
 * How elliptical the dab becomes as the pen lays over. 0 = tilt ignored (always
 * round); 1 = a flat pen draws a maximally smeared dab. **This is the charcoal
 * knob** — and the one that is dead on any device that won't report tilt.
 */
export const tiltToEccentricity = control({
  scope: labScope,
  value: WRITE.tiltToEccentricity,
  min: 0,
  max: 1,
  step: 0.05,
});

/** Dab radius multiplier when the pen is FLAT. A laid-over pencil covers more paper. */
export const tiltRadiusGain = control({
  scope: labScope,
  value: WRITE.tiltToRadius[1],
  min: 1,
  max: 5,
  step: 0.1,
  unit: "×",
});

/** Dab opacity multiplier when the pen is FLAT. …and covers it more thinly. */
export const tiltAlphaGain = control({
  scope: labScope,
  value: WRITE.tiltToAlpha[1],
  min: 0.2,
  max: 1,
  step: 0.05,
  unit: "×",
});

/** Dab opacity multiplier at full speed. The only expressive signal a mouse has. */
export const velocityAlphaGain = control({
  scope: labScope,
  value: WRITE.velocityToAlpha[1],
  min: 0.2,
  max: 1,
  step: 0.05,
  unit: "×",
});

/** The speed (px/ms) at which the velocity dynamics reach their far end. */
export const velocityRef = control({
  scope: labScope,
  value: WRITE.velocityRef,
  min: 0.5,
  max: 10,
  step: 0.1,
});

// ── paper ───────────────────────────────────────────────────────────────────

/** How much the paper's tooth eats the mark. The mechanical-pencil tell. */
export const grain = control({ scope: labScope, value: WRITE.grain, min: 0, max: 1, step: 0.05 });

/** Tooth size in CSS px. Anchored to the CANVAS, never to the stroke. */
export const grainScale = control({
  scope: labScope,
  value: 2.4,
  min: 0.5,
  max: 8,
  step: 0.1,
  unit: "px",
});

// ── the surface ─────────────────────────────────────────────────────────────

/** Lay graphite down, or take it off. An eraser is a stroke like any other. */
export const tool = control<Tool>({ scope: labScope, value: "draw", options: ["draw", "erase"] });

/**
 * Vanishing-ink lifetime. `0` persists until cleared. Above zero, strokes ride
 * the hold → charge → pop warp curve and are gone — which is the overlay's
 * gesture ink, and the reason the surface keeps stroke identity at all.
 */
export const fadeSec = control({
  scope: labScope,
  value: 0,
  min: 0,
  max: 12,
  step: 0.5,
  unit: " s",
});

/**
 * How many permanent strokes stay individually undoable as raster tiles.
 * Temporary ink expires by fadeSec instead; raw permanent samples remain after flattening.
 */
export const retention = control({ scope: labScope, value: 64, min: 1, max: 200, step: 1 });

// ── what the diagnostic OVERLAY draws, on top of the real paper ─────────────
//
// The Lab's point is that a tuning rig which can only show you the finished
// stroke can tell you THAT it looks wrong, never WHERE it went wrong. So every
// stage of the pipeline can be laid over the real mark. Defaults are quiet: you
// come here to look at the pencil, and turn the instrumentation on when it
// surprises you.

/** Show the raw pointer samples, exactly as the browser delivered them. */
export const showRaw = control({ scope: labScope, value: false });

/** Show the samples after the One-Euro low-pass. */
export const showFiltered = control({ scope: labScope, value: false });

/** Show the corners the spline was told not to smooth through. */
export const showCusps = control({ scope: labScope, value: false });

/** Show the dabs — as outlines, so their size, ellipse, and angle are legible. */
export const showDabs = control({ scope: labScope, value: false });

/** Fill the dabs instead of outlining them: the closest phase-2 gets to a stroke. */
export const fillDabs = control({ scope: labScope, value: false });

// ── durable state (not the control surface — the surface is curated) ────────

/**
 * The running telemetry snapshot.
 *
 * The recorder offers a new one on **every sample** — 120+ a second — and the
 * `throttled` valve decides what the graph actually sees: at most 4 commits a
 * second, latest wins, and the last one always lands (so the final state of a
 * stroke is never stranded in a buffer). The island therefore has no timer of
 * its own and no cadence policy in it; it just tells the truth as often as it
 * knows it, and the boundary throttles.
 */
export const telemetry = throttled(
  labScope.durableSignal("telemetry", PenRecorder.emptySnapshot()),
  4,
);

/**
 * The pen recorder: an imperative object that sees every coalesced sample at
 * 120+ Hz. It is deliberately NOT reactive — it writes into the two signals
 * above on its own slow schedule (one write per completed stroke; a telemetry
 * snapshot four times a second). An island that touched a signal per sample
 * would spend the whole stroke re-running the graph instead of drawing.
 */
export const recorder = labScope.durable("recorder", () => new PenRecorder());

/**
 * The diagnostic overlay's canvas and rAF loop. Durable so that a hot edit to a
 * component does not throw away the drawing you were in the middle of tuning —
 * which, in a lab whose whole premise is "draw once, then move the knobs", would
 * be fatal.
 */
export const pad = labScope.durable("pad", () => new PadRenderer());

/** The live control values, assembled into the parameter object the library speaks. */
export function currentParams(): PencilParams {
  return {
    filter: { minCutoff: minCutoff.get(), beta: beta.get(), dCutoff: 1.0 },
    cuspThreshold: (cuspAngle.get() * Math.PI) / 180,
    cuspWindow: cuspWindow.get(),
    maxStep: 2,

    size: size.get(),
    spacing: spacing.get(),
    flow: flow.get(),
    color: "#2b2b33",

    pressureToRadius: [pressureRadiusFloor.get(), 1.0],
    pressureToAlpha: [pressureAlphaFloor.get(), 1.0],
    tiltToEccentricity: tiltToEccentricity.get(),
    tiltToRadius: [1.0, tiltRadiusGain.get()],
    tiltToAlpha: [1.0, tiltAlphaGain.get()],
    velocityToAlpha: [1.0, velocityAlphaGain.get()],
    velocityRef: velocityRef.get(),

    grain: grain.get(),
    grainScale: grainScale.get(),
  };
}

/**
 * **The pencil itself** — the real three-tier surface (`settled` / `retained` /
 * live), with grain, erasing, undo, and the vanishing warp.
 *
 * It is constructed against `document.body` and the component then re-parents its
 * canvas into the pad (appending moves the node) — the same move the overlay's
 * ink layer makes. Durable, so a component edit never costs you the drawing.
 *
 * Note what the option callbacks read: `currentParams()` is called PER STROKE
 * START, so a stroke keeps the brush it began with even if you drag a slider
 * halfway through it. `fadeSec` and `tool` are read where they are needed. None
 * of this is reactive — the surface is an imperative island, and the knobs reach
 * it by being read, not by being subscribed to.
 */
export const paper = labScope.durable(
  "paper",
  () =>
    new PencilSurface({
      className: "paper-canvas",
      params: () => currentParams(),
      tool: () => tool.get(),
      fadeSec: () => fadeSec.get(),
      retention: () => retention.get(),
      // Opaque paper, matching --paper in styles.css.
      background: () => "#f4f1ea",
      // D4's scratchpad half, demonstrated: the Lab's pad is a component, not an
      // overlay, so resizing the window RESCALES the drawing (each stroke re-baked
      // from raw points, its own brush width scaled along) instead of stranding it.
      resize: "rescale",
    }),
);

/**
 * The drawing, as signals — the surface's own record, bound by `inkSignals`.
 *
 * This REPLACED a hand-rolled `strokes` durableSignal that the Lab maintained
 * through an `onStrokeEnd` callback. The surface is the one place a stroke is
 * captured (it alone knows samples + tool + bounds — a second recording is how
 * the tool went missing once already), and now it is also the one place the
 * stroke list lives: undo, clear, fade-outs, and programmatic replays all update
 * `ink.strokes()` without the Lab lifting a finger. `ink.live()` is the stroke
 * under the pen, cumulative points at ~15 Hz — statistics mid-stroke.
 */
export const ink = labScope.durable("ink-signals", () => inkSignals(paper));
