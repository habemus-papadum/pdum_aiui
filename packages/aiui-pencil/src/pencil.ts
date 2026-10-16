/** Numerical and visual presets. Applications and agents supply the meaning of ink. */
import type { BrushParams } from "./dabs";
import type { GeometryParams } from "./stroke-geometry";

export type PencilPreset = "write" | "sketch";
export type Ramp = readonly [number, number];

/** Complete per-stroke profile, captured when a stroke begins. */
export interface PencilParams extends GeometryParams, BrushParams {}

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
 * coarser spacing, and tilt fully engaged — laying the
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

/** Select a numerical preset; no classification or inferred intent. */
export function pencilPreset(preset: PencilPreset): PencilParams {
  return preset === "sketch" ? SKETCH : WRITE;
}
