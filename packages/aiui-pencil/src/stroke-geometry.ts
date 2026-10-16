/** Brush-independent batch geometry. No canvas, reactive state, or device binding. */
import { detectCusps } from "./corners";
import { type OneEuroConfig, PointFilter } from "./filter";
import { densify } from "./spline";
import type { PenSample } from "./telemetry";

export interface GeometryParams {
  filter: OneEuroConfig;
  /** Turning angle in radians and arc-length neighborhood in ink units. */
  cuspThreshold: number;
  cuspWindow: number;
  /** Maximum interpolation step in ink units. */
  maxStep: number;
}

export interface StrokeGeometry {
  raw: PenSample[];
  /** One filtered point for each source sample, in the same order. */
  filtered: PenSample[];
  /** Corner flags indexed by source sample. */
  cusps: boolean[];
  /** Processed centerline. This is not the painted footprint. */
  densified: PenSample[];
}

/**
 * A fresh causal filter over the complete sample list. Live planning uses this
 * same batch reference on each growing prefix; it does not retain filter state.
 */
export function filterSamples(samples: readonly PenSample[], params: GeometryParams): PenSample[] {
  const filter = new PointFilter(params.filter);
  return samples.map((sample) => {
    const { x, y } = filter.filter(sample.x, sample.y, sample.t);
    return { ...sample, x, y };
  });
}

/** Keep all stages inspectable while allowing geometry to be used without a brush. */
export function processStrokeGeometry(
  raw: readonly PenSample[],
  params: GeometryParams,
): StrokeGeometry {
  const filtered = filterSamples(raw, params);
  const cusps = detectCusps(filtered, {
    window: params.cuspWindow,
    threshold: params.cuspThreshold,
  });
  return {
    raw: raw.map((sample) => ({ ...sample })),
    filtered,
    cusps,
    densified: densify(filtered, cusps, { maxStep: params.maxStep }),
  };
}
