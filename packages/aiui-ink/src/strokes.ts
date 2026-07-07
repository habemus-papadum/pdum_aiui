/**
 * Pure stroke geometry — no DOM, no canvas. These are the primitives {@link
 * InkSurface} draws with, factored out so the math (bounds, midpoint
 * smoothing, fade alpha, pressure→width) is testable without a browser.
 */

/** A single sampled pen/touch point, in the surface's own CSS-pixel space. */
export interface InkPoint {
  x: number;
  y: number;
  /** Normalized pen pressure 0..1 when the device reports it; else omitted. */
  pressure?: number;
}

/** An axis-aligned rectangle (same shape the overlay uses for shot rects). */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** How a stroke's width is chosen. Constant unless the points carry pressure. */
export interface StrokeStyle {
  /** CSS color string. */
  color: string;
  /** Nominal line width in CSS px (the pressure=1 width). */
  width: number;
}

/**
 * A stroke: an ordered point list plus its style. `bornAt` is the fade clock's
 * zero — set at pen-up so fading starts when the gesture completes — and `live`
 * marks a stroke still being drawn (local drag in flight, or a remote stroke
 * whose `end` hasn't arrived), which never fades.
 */
export interface Stroke extends StrokeStyle {
  id: string;
  points: InkPoint[];
  bornAt: number;
  live: boolean;
}

/** The tight bounding box of a point list. Empty rect for 0 points. */
export function boundsOf(points: readonly InkPoint[]): Rect {
  if (points.length === 0) {
    return { x: 0, y: 0, w: 0, h: 0 };
  }
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** One quadratic segment of a smoothed stroke: control point → end point. */
export interface Segment {
  /** Control point (the previous sample). */
  cx: number;
  cy: number;
  /** End point (the midpoint between the previous and current sample). */
  x: number;
  y: number;
}

/**
 * Midpoint smoothing — cheap and good enough for gesture ink (the exact scheme
 * the overlay's Ink used). Given N points it returns N-1 quadratic segments
 * whose control points are the raw samples and whose endpoints are the
 * midpoints, plus an implicit `moveTo(points[0])`. Fewer than two points yields
 * no segments (a dot is drawn by the caller).
 */
export function smoothedSegments(points: readonly InkPoint[]): Segment[] {
  const out: Segment[] = [];
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const point = points[i];
    out.push({
      cx: prev.x,
      cy: prev.y,
      x: (prev.x + point.x) / 2,
      y: (prev.y + point.y) / 2,
    });
  }
  return out;
}

/**
 * A stroke's current opacity. `fadeMs <= 0` means persist (always 1). A live
 * stroke never fades. Otherwise it ramps 1 → 0 linearly over `fadeMs` from
 * `bornAt`, clamped to [0, 1].
 */
export function strokeAlpha(
  stroke: Pick<Stroke, "bornAt" | "live">,
  now: number,
  fadeMs: number,
): number {
  if (fadeMs <= 0 || stroke.live) {
    return 1;
  }
  const age = now - stroke.bornAt;
  if (age <= 0) {
    return 1;
  }
  return Math.max(0, 1 - age / fadeMs);
}

/**
 * Effective line width for a point, modulating the nominal width by pressure
 * when present (half-width at 0 pressure, full at 1). Pressure-less points draw
 * at the nominal width.
 */
export function pressureWidth(nominal: number, pressure: number | undefined): number {
  if (pressure === undefined) {
    return nominal;
  }
  return nominal * (0.5 + 0.5 * Math.max(0, Math.min(1, pressure)));
}
