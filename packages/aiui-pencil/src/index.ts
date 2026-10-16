/** Editable stroke input, pure geometry, disposable Canvas views, and Solid observation. */
export * from "./attachment";
export { type CuspConfig, detectCusps } from "./corners";
export {
  type BrushParams,
  type Dab,
  dabAt,
  earliestChangedDab,
  planBrush,
  planStroke,
  type StrokePlan,
} from "./dabs";
export * from "./document";
export { type OneEuroConfig, PointFilter } from "./filter";
export { polygonArea, polylineLength, type Rect, resampleByArcLength, type Vec } from "./geom";
export * from "./geometry";
export { guardPenControls, type PenControlOptions, penWriting } from "./input/controls";
export {
  bindPenInput,
  type InputBounds,
  type PenActivity,
  type PenInputBinding,
  type PenInputCounts,
  type PenInputOptions,
  type PenInputSamples,
  type PenSink,
} from "./input/pointer";
export * from "./input/policy";
export {
  type PencilParams,
  type PencilPreset,
  pencilPreset,
  type Ramp,
  SKETCH,
  WRITE,
} from "./pencil";
export {
  createInkPresentation,
  InkPresentation,
  type InkPresentationOptions,
} from "./presentation";
export { type InkSignals, type InkSource, inkSignals } from "./reactive";
export { CanvasInkView, type CanvasInkViewOptions, createCanvasInkView } from "./renderer";
export { type DensifyConfig, densify } from "./spline";
export {
  filterSamples,
  type GeometryParams,
  processStrokeGeometry,
  type StrokeGeometry,
} from "./stroke-geometry";
export { type PencilNavigationOptions, PencilSurface, type PencilSurfaceOptions } from "./surface";
export {
  emptyTelemetry,
  type InputReport,
  inputReport,
  observe,
  type PenKind,
  type PenSample,
  type PenSupport,
  type PointerLike,
  penSample,
  penSupport,
  type Range,
  type Telemetry,
  type TiltVerdict,
  tiltVerdict,
} from "./telemetry";
export const name = "@habemus-papadum/aiui-pencil";

export { createInkSession, type InkSession, type InkSessionOptions } from "./session";
