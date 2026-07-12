/**
 * `aiui-ink` — a reusable canvas ink surface.
 *
 * {@link InkSurface} turns local pointer drags into strokes and accepts strokes
 * fed in from elsewhere (a remote pen), each with its own color and width, with
 * optional fade and screenshot compositing. Framework-free and dependency-free;
 * the pure geometry lives in `./strokes` so it can be unit-tested and reused off
 * the DOM.
 *
 * @packageDocumentation
 */

export {
  CHARGE_GLOW,
  type FadeStyle,
  FULL_STYLE,
  fadeStyle,
  heat,
  INK_CHARGE,
  INK_HOLD,
} from "./fade";
export type { InkSurfaceOptions, LocalStroke } from "./ink-surface";
export { InkSurface } from "./ink-surface";
export type { InkPoint, Rect, Segment, Stroke, StrokeStyle } from "./strokes";
export { boundsOf, pressureWidth, smoothedSegments, strokeAlpha } from "./strokes";

/** The published package name — handy for smoke tests. */
export const name = "@habemus-papadum/aiui-ink";
