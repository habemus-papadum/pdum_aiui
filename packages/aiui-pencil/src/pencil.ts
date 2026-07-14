/**
 * pencil.ts — the instrument: its parameters, its presets, and the resolver that
 * leaves the door open to there being only one mode. Playbook layer 1: pure.
 *
 * ## One pencil
 *
 * There is no brush library here and there is not going to be one. There is a
 * single instrument whose *range lives in your hand*: press harder and it
 * darkens and broadens; lay it over and the contact patch turns elliptical and
 * it becomes charcoal. A menu of ten brushes is what you build when the one
 * brush cannot respond to how it is being held.
 *
 * ## Modes are a parameter set, not a code path
 *
 * Four modes suggest themselves — gesture, writing, mathematical notation,
 * sketching — and they collapse to two. Gesture, writing, and math all want the
 * same thing: responsiveness over smoothness, and corners kept. A lasso around a
 * chart and the letter `x` fail in exactly the same way if the filter rounds
 * their corners off. Their differences are of degree, and degree is what a
 * parameter is for. So: `write` and `sketch`.
 *
 * ## …and the door is left open to there being one
 *
 * {@link resolveParams} is a function of the stroke's own telemetry, not a lookup
 * in a table. For `write` and `sketch` it ignores that argument and returns a
 * constant — a preset is the degenerate case of an adaptive mode. But the shape
 * is already the adaptive one, so the day we believe a stroke's early telemetry
 * (its speed, its extent, how flat the pen is being held) can tell writing from
 * sketching without being asked, `auto` becomes an implementation rather than a
 * refactor. It ships as an alias for `write` until it earns more.
 */

import type { OneEuroConfig } from "./filter";

/** The three modes. `auto` is reserved — see the module header. */
export type PencilMode = "write" | "sketch" | "auto";

/** A closed range, `[at zero, at one]`, that some pen signal drives across. */
export type Ramp = readonly [number, number];

/**
 * Everything the instrument is. Every field here is a knob in the Lab, and the
 * Lab is the only place any of these numbers should be argued about — they are
 * defaults to be *drawn with*, not values to be reasoned toward.
 */
export interface PencilParams {
  // ── conditioning: what happens to the points before anything is drawn ──────
  /** The causal low-pass. Writing wants it out of the way; sketching wants it working. */
  filter: OneEuroConfig;
  /** How hard a turn counts as a corner (radians), and over what arc-length window (px). */
  cuspThreshold: number;
  cuspWindow: number;
  /** Longest straight step the densified spline may take, px. Fidelity, not taste. */
  maxStep: number;

  // ── the mark ───────────────────────────────────────────────────────────────
  /** Nominal dab radius (px) — the mark of an upright pen at full pressure. */
  size: number;
  /** Dab spacing as a fraction of dab radius. Below ~0.25 the stroke is solid. */
  spacing: number;
  /** Base opacity of a single dab, before any dynamics. The graphite's darkness. */
  flow: number;
  /** CSS color. A pencil is not black — 6B graphite is a warm dark grey. */
  color: string;

  // ── dynamics: how the pen's telemetry moves the mark ───────────────────────
  /** Radius multiplier across pressure 0..1. */
  pressureToRadius: Ramp;
  /** Alpha multiplier across pressure 0..1. Pressing harder lays more graphite. */
  pressureToAlpha: Ramp;
  /**
   * How elliptical the dab becomes as the pen lays over. 0 = always round (tilt
   * ignored); 1 = a fully flat pen draws a maximally elongated dab. THIS is the
   * charcoal knob, and it is the one that dies if Safari won't tell us the tilt.
   */
  tiltToEccentricity: number;
  /** Radius multiplier from upright (1) to flat — a laid-over pencil covers more paper. */
  tiltToRadius: Ramp;
  /** Alpha multiplier from upright (1) to flat — and covers it more thinly. */
  tiltToAlpha: Ramp;
  /**
   * How much speed thins the mark. The ONLY expressive signal a mouse or a
   * finger has, so it is never zero — a pressure-less device still gets a
   * living line out of it.
   */
  velocityToAlpha: Ramp;
  /** Speed (px/ms) at which `velocityToAlpha` reaches its far end. */
  velocityRef: number;

  // ── paper ──────────────────────────────────────────────────────────────────
  /** How much the paper's tooth eats the mark, 0..1. The mechanical-pencil tell. */
  grain: number;
  /** Tooth size in px. Anchored to the CANVAS, never to the stroke (see grain.ts). */
  grainScale: number;
}

/**
 * Writing — and gesture, and mathematical notation. Responsive over smooth:
 * a low `beta` would lag the pen, and lag is what makes handwriting feel dead.
 * A tight cusp threshold, because in text a corner is nearly always meant. Fine
 * spacing, narrow dynamic range: legibility is the whole job.
 */
export const WRITE: PencilParams = {
  filter: { minCutoff: 1.6, beta: 0.9, dCutoff: 1.0 },
  cuspThreshold: Math.PI / 3, // 60°
  cuspWindow: 5,
  maxStep: 2,

  size: 1.6,
  spacing: 0.18,
  flow: 0.55,
  color: "#2b2b33",

  pressureToRadius: [0.55, 1.0],
  pressureToAlpha: [0.35, 1.0],
  tiltToEccentricity: 0.35,
  tiltToRadius: [1.0, 1.6],
  tiltToAlpha: [1.0, 0.75],
  velocityToAlpha: [1.0, 0.8],
  velocityRef: 3.0,

  grain: 0.35,
  grainScale: 2.2,
};

/**
 * Sketching. Heavier streamlining (a fast arc should come out as an arc, not a
 * polygon), a looser cusp threshold so a quick loop isn't chopped into facets,
 * coarser spacing, and tilt fully engaged — this is the mode where laying the
 * pencil over is *the point*.
 */
export const SKETCH: PencilParams = {
  filter: { minCutoff: 0.7, beta: 0.25, dCutoff: 1.0 },
  cuspThreshold: (Math.PI * 5) / 9, // 100°
  cuspWindow: 9,
  maxStep: 2,

  size: 3.2,
  spacing: 0.22,
  flow: 0.4,
  color: "#2b2b33",

  pressureToRadius: [0.5, 1.3],
  pressureToAlpha: [0.25, 1.0],
  tiltToEccentricity: 0.9,
  tiltToRadius: [1.0, 3.2],
  tiltToAlpha: [1.0, 0.5],
  velocityToAlpha: [1.0, 0.65],
  velocityRef: 4.0,

  grain: 0.65,
  grainScale: 2.8,
};

/**
 * What an adaptive mode would get to look at. Populated from the opening of a
 * stroke (and, once `auto` is real, updated as it develops).
 *
 * It is deliberately *not* the raw sample list: an adaptive resolver that can
 * see everything will end up depending on everything, and this is a seam we want
 * to stay narrow. Speed, size, and how flat the pen is being held are the
 * signals a human would use to tell writing from sketching at a glance, and they
 * are almost certainly enough.
 */
export interface StrokeContext {
  /** Mean speed so far, px/ms. */
  speed: number;
  /** Diagonal of the stroke's bounding box so far, px. Letters are small. */
  extent: number;
  /** Mean altitude so far, radians. A laid-over pen is sketching. */
  altitude: number;
}

/** A stroke that has told us nothing yet: upright, still, dimensionless. */
export const NEW_STROKE: StrokeContext = { speed: 0, extent: 0, altitude: Math.PI / 2 };

/**
 * The mode resolver. **This signature is the placeholder** described in the
 * module header: it takes the stroke's telemetry, and today it ignores it.
 *
 * When `auto` becomes real it will live here and nowhere else — every caller
 * already passes what it would need.
 */
export function resolveParams(mode: PencilMode, _stroke: StrokeContext = NEW_STROKE): PencilParams {
  switch (mode) {
    case "sketch":
      return SKETCH;
    case "auto":
      // Reserved. Today: writing, which is the safe default — a stroke wrongly
      // smoothed as a sketch has lost information, while a sketch wrongly
      // treated as writing merely looks a little crisp.
      return WRITE;
    default:
      return WRITE;
  }
}
