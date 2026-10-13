/**
 * `aiui-pencil` — local pencil input, rendering, and drawing data.
 *
 * A pencil whose range lives in your hand: pressure darkens and broadens it,
 * laying it over turns the contact patch elliptical and it becomes charcoal.
 * Textured strokes, a real eraser, and vanishing ink, on a raster surface that
 * keeps stroke identity exactly as long as it needs to and not one frame longer.
 *
 * Design, plan, and status: the aiui-pencil proposal and its plan, in git
 * history. Supersedes the retired `aiui-ink` and `aiui-paint` (git history).
 *
 * **The core is layer 1: the pure stroke pipeline** — everything from a
 * `PointerEvent` to a list of dabs, with no DOM anywhere in it. Layered on top,
 * and exported below: the renderer (`PencilSurface`, surface.ts), local input
 * policy (`input/`), and the Solid adapter (`reactive.ts`).
 *
 * The pipeline, end to end:
 *
 * ```text
 *   PointerEvent → penSample()     normalize; derive whichever orientation pair
 *                                  the browser withheld           (telemetry.ts)
 *                → filterSamples() causal One-Euro low-pass          (filter.ts)
 *                → detectCusps()   the corners a spline must NOT
 *                                  smooth through                   (corners.ts)
 *                → densify()       centripetal Catmull-Rom, broken
 *                                  at those corners                  (spline.ts)
 *                → resample…()     onto the dab grid, by ARC LENGTH     (geom.ts)
 *                → dabAt()         pressure/tilt/azimuth/velocity
 *                                  → the stamp                        (dabs.ts)
 * ```
 *
 * {@link planStroke} runs all of it and **keeps every intermediate stage**, which
 * is what the Lab draws — a tuning rig that can only show you the final stroke
 * can tell you *that* it looks wrong, never *where* it went wrong.
 *
 * @packageDocumentation
 */

export { type CuspConfig, detectCusps } from "./corners";
export { type Dab, dabAt, filterSamples, planStroke, type StrokePlan } from "./dabs";
export type { OneEuroConfig } from "./filter";
export {
  polygonArea,
  polylineLength,
  type Rect,
  resampleByArcLength,
  type Vec,
} from "./geom";
export { guardPenControls, penWriting } from "./input/controls";
export {
  bindPenInput,
  type InputBounds,
  type PenActivity,
  type PenInputBinding,
  type PenInputOptions,
  type PenSink,
} from "./input/pointer";
export {
  NEW_STROKE,
  type PencilMode,
  type PencilParams,
  type Ramp,
  resolveParams,
  SKETCH,
  type StrokeContext,
  WRITE,
} from "./pencil";
// reactive.ts — the Solid face of a surface: the drawing as signals (committed
// immediately; the live stroke throttled but LOSSLESS — cumulative snapshots).
export { type InkSignals, type InkSource, inkSignals } from "./reactive";
export { type DensifyConfig, densify } from "./spline";
export {
  type InkEvent,
  type InkState,
  type InkStroke,
  PencilSurface,
  type PencilSurfaceOptions,
  type StrokeEnd,
  type Tool,
} from "./surface";
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

/** The published package name — handy for smoke tests. */
export const name = "@habemus-papadum/aiui-pencil";
