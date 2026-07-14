/**
 * dabs.ts — samples in, dabs out. The instrument's physics. Playbook layer 1:
 * pure, realm-free, and the last module before anything touches a canvas.
 *
 * A dab is one stamp of graphite. A stroke is a few hundred of them laid down
 * along the path at even *distance* (never even time — see geom.ts), each shaped
 * and darkened by how the pen was being held at that spot. Everything expressive
 * about this pencil is a mapping from pen telemetry to dab parameters, and they
 * all live in {@link dabAt}:
 *
 *   pressure  → radius, alpha        harder ⇒ broader, darker
 *   altitude  → eccentricity, radius, alpha
 *                                    laying the pencil over turns the round
 *                                    contact patch into an ELLIPSE — the flat of
 *                                    the lead meets the paper. Wide, elongated,
 *                                    lighter: charcoal, falling out of the
 *                                    geometry rather than being a "charcoal mode"
 *   azimuth   → the ellipse's angle  the direction it leans is the direction it
 *                                    smears
 *   velocity  → alpha                fast ⇒ less graphite. And the ONLY signal a
 *                                    mouse or a finger has, which is why a
 *                                    pressure-less device still gets a live line
 *
 * The pipeline is exposed stage by stage ({@link StrokePlan}) rather than as one
 * opaque `samples → dabs`. That is deliberate, and it is the same instinct the
 * rest of this repo applies to prompt lowering: the intermediate representations
 * are where the understanding is, and a tuning lab that cannot show you the
 * filtered points, the detected corners, and the resampled grid is a lab that
 * can only tell you *that* a stroke looks wrong, never *where* it went wrong.
 */

import { detectCusps } from "./corners";
import { PointFilter } from "./filter";
import { dist, resampleByArcLength } from "./geom";
import type { PencilParams, Ramp } from "./pencil";
import { blendSample, densify } from "./spline";
import type { PenSample } from "./telemetry";

const HALF_PI = Math.PI / 2;

/**
 * The most a fully laid-over pencil stretches its contact patch, as a multiple
 * of the round radius, at `tiltToEccentricity = 1`. Not a knob: it is the far
 * end of the scale the knob interpolates along, and moving it would just rescale
 * the knob.
 */
const MAX_ELONGATION = 3.5;

/** One stamp of graphite. Canvas coordinates; the renderer just draws these. */
export interface Dab {
  x: number;
  y: number;
  /** Semi-axis along `angle` (the lean direction) — the long one when tilted. */
  rx: number;
  /** Semi-axis across it. */
  ry: number;
  /** Rotation of the ellipse, radians. The pen's azimuth. */
  angle: number;
  /** 0..1, before the paper's tooth takes its cut (grain is applied per tile). */
  alpha: number;
}

/**
 * Every stage of the pipeline, kept. The Lab renders these on top of each other;
 * the tests assert on them individually; the renderer only wants `.dabs`.
 */
export interface StrokePlan {
  raw: PenSample[];
  /** After the One-Euro causal low-pass. */
  filtered: PenSample[];
  /** Per-point: is this a corner the spline must NOT smooth through? */
  cusps: boolean[];
  /** After centripetal Catmull-Rom, broken at the cusps. */
  densified: PenSample[];
  /** After arc-length resampling to the dab grid. */
  spaced: PenSample[];
  /** Speed at each spaced sample, px/ms — kept because it is invisible otherwise. */
  speeds: number[];
  dabs: Dab[];
}

/** Interpolate a ramp: `t` 0..1 maps across `[at zero, at one]`. */
export function ramp(r: Ramp, t: number): number {
  const u = t < 0 ? 0 : t > 1 ? 1 : t;
  return r[0] + (r[1] - r[0]) * u;
}

/**
 * Run the causal filter over a whole list. The live surface feeds its filter one
 * point at a time as they arrive — that is what "causal" is for — but a fresh
 * filter driven over a recorded list produces exactly the same sequence, which
 * is what makes the pipeline testable and what lets the Lab re-run a captured
 * stroke through new parameters without re-drawing it.
 */
export function filterSamples(samples: readonly PenSample[], params: PencilParams): PenSample[] {
  const filter = new PointFilter(params.filter);
  return samples.map((s) => {
    const { x, y } = filter.filter(s.x, s.y, s.t);
    return { ...s, x, y };
  });
}

/** Speed (px/ms) at each point, from its own spacing and timing. */
export function speedsOf(samples: readonly PenSample[]): number[] {
  if (samples.length === 0) {
    return [];
  }
  const speeds = new Array<number>(samples.length).fill(0);
  for (let i = 1; i < samples.length; i++) {
    const dt = samples[i].t - samples[i - 1].t;
    speeds[i] = dt > 0 ? dist(samples[i - 1], samples[i]) / dt : 0;
  }
  // The first point has no history; borrow the second's, so a stroke doesn't
  // open with a spurious "stationary" (and therefore heavy) dab.
  speeds[0] = speeds.length > 1 ? speeds[1] : 0;
  return speeds;
}

/**
 * The pressure to actually draw with.
 *
 * A pen that reports pressure is believed. Everything else — a mouse (which
 * reports a flat 0.5 while held down), a finger, a stylus whose browser tells us
 * nothing — gets pressure **simulated from speed**: slow means heavy. It is a
 * genuinely good approximation of how people press, it is what every serious
 * freehand renderer does, and without it a mouse draws a dead constant-width
 * line, which is exactly the failure the current ink surface has.
 */
export function effectivePressure(sample: PenSample, speed: number, params: PencilParams): number {
  if (sample.kind === "pen" && sample.pressure > 0) {
    return sample.pressure;
  }
  const fast = Math.min(1, speed / Math.max(0.01, params.velocityRef));
  return 1 - fast;
}

/**
 * One dab: the instrument's whole physics, in one function.
 *
 * `flatness` — 0 upright, 1 flat on the page — is the tilt signal in the form
 * everything actually wants. Note that when a browser reports no orientation at
 * all, `telemetry.ts` hands us an upright pen, so `flatness` is 0, so every tilt
 * term multiplies by its identity and quietly vanishes. The pencil degrades to
 * pressure-and-velocity without a single branch.
 */
export function dabAt(sample: PenSample, speed: number, params: PencilParams): Dab {
  const pressure = effectivePressure(sample, speed, params);
  const flatness = 1 - Math.min(1, Math.max(0, sample.altitude / HALF_PI));

  const radius =
    params.size * ramp(params.pressureToRadius, pressure) * ramp(params.tiltToRadius, flatness);

  // The contact patch elongates along the lean. Round when upright, by construction.
  const elongation = 1 + params.tiltToEccentricity * flatness * MAX_ELONGATION;

  const speedT = Math.min(1, speed / Math.max(0.01, params.velocityRef));
  const alpha =
    params.flow *
    ramp(params.pressureToAlpha, pressure) *
    ramp(params.tiltToAlpha, flatness) *
    ramp(params.velocityToAlpha, speedT);

  return {
    x: sample.x,
    y: sample.y,
    rx: radius * elongation,
    ry: radius,
    angle: sample.azimuth,
    alpha: Math.min(1, Math.max(0, alpha)),
  };
}

/**
 * The whole pipeline, every stage kept: filter → find corners → spline (breaking
 * at them) → resample onto the dab grid → stamp.
 *
 * Dab spacing is a fraction of the dab *radius*, and the radius varies along the
 * stroke — so the grid is, strictly, non-uniform. We resample against the
 * nominal radius rather than solving that circularity: the error is small (the
 * radius changes slowly compared to the spacing), and the alternative is an
 * iteration that buys nothing the eye can see. If a pathological case ever shows
 * up — a stroke that goes from feather-light to full pressure in a few px — this
 * is the assumption that broke.
 */
export function planStroke(raw: readonly PenSample[], params: PencilParams): StrokePlan {
  const filtered = filterSamples(raw, params);
  const cusps = detectCusps(filtered, {
    window: params.cuspWindow,
    threshold: params.cuspThreshold,
  });
  const densified = densify(filtered, cusps, { maxStep: params.maxStep });

  const spacing = Math.max(0.05, params.size * params.spacing);
  const spaced = resampleByArcLength(densified, spacing, blendSample);

  const speeds = speedsOf(spaced);
  const dabs = spaced.map((s, i) => dabAt(s, speeds[i], params));

  return { raw: [...raw], filtered, cusps, densified, spaced, speeds, dabs };
}
