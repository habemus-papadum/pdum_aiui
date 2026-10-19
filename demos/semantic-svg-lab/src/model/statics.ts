/** Ideal rigid, weightless beam: a pin at A, a roller at B, and one downward point load. */
export const BEAM_SPAN = 4;
export const LOAD_LIMITS = { min: 20, max: 200, step: 5 } as const;
export const POSITION_LIMITS = { min: 0, max: 100, step: 1 } as const;
export type BeamFeature = "load" | "left" | "right" | "position" | "span";
export const BEAM_FEATURES: BeamFeature[] = ["load", "left", "right", "position", "span"];
export interface BeamInput {
  load: number;
  positionPercent: number;
}
export function solveBeam(input: BeamInput) {
  if (
    !Number.isFinite(input.load) ||
    input.load < LOAD_LIMITS.min ||
    input.load > LOAD_LIMITS.max ||
    input.load % LOAD_LIMITS.step !== 0
  )
    throw new Error("Load must be 20–200 N in 5 N steps.");
  if (
    !Number.isInteger(input.positionPercent) ||
    input.positionPercent < 0 ||
    input.positionPercent > 100
  )
    throw new Error("Position must be 0–100 percent in whole-percent steps.");
  const distance = (BEAM_SPAN * input.positionPercent) / 100;
  const right = (input.load * input.positionPercent) / 100;
  const left = (input.load * (100 - input.positionPercent)) / 100;
  return {
    ...input,
    span: BEAM_SPAN,
    distance,
    left,
    right,
    horizontalAtA: 0,
    forceResidual: left + right - input.load,
    momentResidual: right * BEAM_SPAN - input.load * distance,
  };
}
export type BeamResult = ReturnType<typeof solveBeam>;
export function beamViewport(width: number) {
  const margin = Math.min(70, width * 0.17);
  return {
    width,
    height: 470,
    left: margin,
    right: width - margin,
    span: width - margin * 2,
    beamY: 230,
  };
}
