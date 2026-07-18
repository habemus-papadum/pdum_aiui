/**
 * geom.ts — vectors, arc length, resampling. Playbook layer 1: pure, realm-free
 * (no DOM, no solid-js), exhaustively tested.
 *
 * The one non-obvious function here is {@link resampleByArcLength}, which is the
 * hinge of the whole dab engine: a pencil lays graphite down at a roughly
 * constant rate *along the paper*, not at a constant rate *in time*. Pointer
 * events arrive at a constant rate in time, so a fast stroke delivers samples
 * far apart and a slow one delivers them on top of each other. Stamping dabs at
 * the raw samples would therefore make fast strokes dotted and slow strokes
 * black. Resampling by distance is what makes a stroke look like a stroke.
 */

/** A point in some 2-D space. Whose pixels is the caller's business. */
export interface Vec {
  x: number;
  y: number;
}

/** An axis-aligned rectangle (the same shape the overlay uses for shot rects). */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function dist(a: Vec, b: Vec): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/** Total length of a polyline. 0 for fewer than two points. */
export function polylineLength(points: readonly Vec[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += dist(points[i - 1], points[i]);
  }
  return total;
}

/**
 * Signed area of the polygon a point sequence encloses (the shoelace formula),
 * treating the path as closed. Positive when the points wind counter-clockwise
 * in a y-up world — which, on a canvas (y-down), means clockwise. Callers who
 * only care about size take `Math.abs`.
 *
 * This is the "what did the user just circle?" primitive: run a stroke's points
 * (raw, or densified through the spline for a fairer boundary) through it and
 * you have the enclosed area in px².
 */
export function polygonArea(points: readonly Vec[]): number {
  if (points.length < 3) {
    return 0;
  }
  let twice = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    twice += a.x * b.y - b.x * a.y;
  }
  return twice / 2;
}

/** Scalar linear interpolation. `t` is NOT clamped — callers pass 0..1. */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Interpolate an angle (radians) the short way around the circle, so a azimuth
 * crossing 0/2π doesn't spin the long way. Result is normalized to [0, 2π).
 */
export function lerpAngle(a: number, b: number, t: number): number {
  const twoPi = Math.PI * 2;
  let delta = (((b - a) % twoPi) + twoPi + Math.PI) % twoPi;
  delta -= Math.PI;
  return normalizeAngle(a + delta * t);
}

/** Fold an angle into [0, 2π). */
export function normalizeAngle(radians: number): number {
  const twoPi = Math.PI * 2;
  return ((radians % twoPi) + twoPi) % twoPi;
}

/**
 * Walk a polyline and emit a point every `spacing` units of arc length, with
 * everything else about the sample interpolated along the way (that is what
 * `blend` is for — pressure, tilt, and time all have to ride along, or the dab
 * at the resampled position would carry the pen telemetry of a position the pen
 * was never at).
 *
 * The first input point is always emitted. The last one is emitted only if it
 * lands on the grid — a trailing partial segment is deliberately dropped rather
 * than stamped at the wrong spacing; a *live* stroke's tail arrives on the next
 * frame anyway, and a finished stroke's final dab is placed by the caller.
 *
 * `spacing <= 0`, or fewer than two points, returns the input unchanged: a dot
 * is a legitimate stroke.
 */
export function resampleByArcLength<T extends Vec>(
  points: readonly T[],
  spacing: number,
  blend: (a: T, b: T, t: number) => T,
): T[] {
  if (spacing <= 0 || points.length < 2) {
    return [...points];
  }
  const out: T[] = [points[0]];
  // Distance already walked past the last emitted point.
  let carried = 0;

  for (let i = 1; i < points.length; i++) {
    const from = points[i - 1];
    const to = points[i];
    const segment = dist(from, to);
    if (segment === 0) {
      continue; // a duplicate sample: no arc to walk
    }
    // Where along THIS segment the next grid point falls.
    let cursor = spacing - carried;
    while (cursor <= segment) {
      out.push(blend(from, to, cursor / segment));
      cursor += spacing;
    }
    // What's left over rolls into the next segment.
    carried = segment - (cursor - spacing);
  }
  return out;
}
