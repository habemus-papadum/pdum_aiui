/** Pure coordinate mappings and queries against stroke footprints and erasure coverage. */
import type { Dab } from "./dabs";
import { dist, type Rect, type Vec } from "./geom";

/** Maps ink to a view, or stroke-local coordinates to document ink. Scale is positive. */
export interface InkTransform {
  x: number;
  y: number;
  scale: number;
  /** Clockwise radians in the browser's y-down coordinates. Omitted means zero. */
  rotation?: number;
}

export const IDENTITY_TRANSFORM: Readonly<InkTransform> = Object.freeze({ x: 0, y: 0, scale: 1 });

export function validateTransform(transform: InkTransform): void {
  if (
    !Number.isFinite(transform.x) ||
    !Number.isFinite(transform.y) ||
    !Number.isFinite(transform.scale) ||
    !Number.isFinite(transform.rotation ?? 0) ||
    transform.scale <= 0
  )
    throw new RangeError(
      "Ink transforms require finite translation and rotation, and positive scale",
    );
}

/** Sensor widths, heights, time, pressure and orientation are deliberately preserved. */
export function applyTransform<T extends Vec>(point: T, transform: InkTransform): T {
  validateTransform(transform);
  const cosine = Math.cos(transform.rotation ?? 0);
  const sine = Math.sin(transform.rotation ?? 0);
  return {
    ...point,
    x: (point.x * cosine - point.y * sine) * transform.scale + transform.x,
    y: (point.x * sine + point.y * cosine) * transform.scale + transform.y,
  };
}

export function invertTransform(transform: InkTransform): InkTransform {
  validateTransform(transform);
  const cosine = Math.cos(transform.rotation ?? 0);
  const sine = Math.sin(transform.rotation ?? 0);
  return {
    x: -(transform.x * cosine + transform.y * sine) / transform.scale,
    y: (transform.x * sine - transform.y * cosine) / transform.scale,
    scale: 1 / transform.scale,
    rotation: -(transform.rotation ?? 0),
  };
}

/** Composition applies `inner` first, then `outer`. */
export function composeTransforms(outer: InkTransform, inner: InkTransform): InkTransform {
  validateTransform(outer);
  validateTransform(inner);
  const origin = applyTransform({ x: inner.x, y: inner.y }, outer);
  const result = {
    ...origin,
    scale: outer.scale * inner.scale,
    rotation: (outer.rotation ?? 0) + (inner.rotation ?? 0),
  };
  validateTransform(result);
  return result;
}

/** Axis-aligned enclosure of all four transformed corners. */
export function transformRectBounds(rect: Rect, transform: InkTransform): Rect {
  const corners = [
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.w, y: rect.y },
    { x: rect.x, y: rect.y + rect.h },
    { x: rect.x + rect.w, y: rect.y + rect.h },
  ].map((point) => applyTransform(point, transform));
  const x = Math.min(...corners.map((point) => point.x));
  const y = Math.min(...corners.map((point) => point.y));
  return {
    x,
    y,
    w: Math.max(...corners.map((point) => point.x)) - x,
    h: Math.max(...corners.map((point) => point.y)) - y,
  };
}

export interface NavigationTransform {
  /** Previous and current centroids in the view's CSS coordinates. */
  from: Vec;
  to: Vec;
  /** Incremental multiplicative zoom and angular change, not absolute settings. */
  scale: number;
  rotation: number;
}

export interface ScaleLimits {
  minScale?: number;
  maxScale?: number;
}

/** Keep the ink under `from` under `to`, including when zoom reaches a limit. */
export function applyNavigationTransform(
  viewport: InkTransform,
  navigation: NavigationTransform,
  limits: ScaleLimits = {},
): InkTransform {
  validateTransform(viewport);
  const minimum = limits.minScale ?? 0;
  const maximum = limits.maxScale ?? Number.POSITIVE_INFINITY;
  if (
    !Number.isFinite(minimum) ||
    minimum < 0 ||
    maximum <= 0 ||
    Number.isNaN(maximum) ||
    maximum < minimum
  ) {
    throw new RangeError("Scale limits require 0 <= minScale <= maxScale and a positive maximum");
  }
  validateTransform({
    x: navigation.to.x,
    y: navigation.to.y,
    scale: navigation.scale,
    rotation: navigation.rotation,
  });
  if (!Number.isFinite(navigation.from.x) || !Number.isFinite(navigation.from.y))
    throw new RangeError("Navigation centroids must be finite");
  const nextScale = Math.max(minimum, Math.min(maximum, viewport.scale * navigation.scale));
  const scale = nextScale / viewport.scale;
  const relative = { x: 0, y: 0, scale, rotation: navigation.rotation };
  const focal = applyTransform(navigation.from, relative);
  return composeTransforms(
    { ...relative, x: navigation.to.x - focal.x, y: navigation.to.y - focal.y },
    viewport,
  );
}

/** `origin` is the surface's client-space origin; viewport uses surface CSS coordinates. */
export function clientToInk<T extends Vec>(
  point: T,
  viewport: InkTransform,
  origin: Vec = { x: 0, y: 0 },
): T {
  return applyTransform(
    { ...point, x: point.x - origin.x, y: point.y - origin.y },
    invertTransform(viewport),
  );
}

export function inkToClient<T extends Vec>(
  point: T,
  viewport: InkTransform,
  origin: Vec = { x: 0, y: 0 },
): T {
  const mapped = applyTransform(point, viewport);
  return { ...mapped, x: mapped.x + origin.x, y: mapped.y + origin.y };
}

function nearestFraction(point: Vec, a: Vec, b: Vec): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const squared = dx * dx + dy * dy;
  return squared === 0
    ? 0
    : Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / squared));
}

export function distanceToSegment(point: Vec, a: Vec, b: Vec): number {
  const t = nearestFraction(point, a, b);
  return Math.hypot(point.x - a.x - (b.x - a.x) * t, point.y - a.y - (b.y - a.y) * t);
}

/** Centerline proximity; use hitVisibleStroke for painted footprint queries. */
export function distanceToPath(point: Vec, path: readonly Vec[]): number {
  if (path.length === 0) return Number.POSITIVE_INFINITY;
  let nearest = dist(point, path[0]);
  for (let i = 1; i < path.length; i++)
    nearest = Math.min(nearest, distanceToSegment(point, path[i - 1], path[i]));
  return nearest;
}

export interface EraserDisk extends Vec {
  radius: number;
}

/** Continuous union of disks along segments, with linearly interpolated radius. */
export interface EraserCoverage {
  points: readonly EraserDisk[];
}

/** Exact point test for a swept disk, including dots and changing radii. */
export function coverageContainsPoint(coverage: EraserCoverage, point: Vec): boolean {
  for (let i = 0; i < coverage.points.length; i++) {
    const a = coverage.points[i];
    const b = coverage.points[i + 1] ?? a;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dr = b.radius - a.radius;
    const px = point.x - a.x;
    const py = point.y - a.y;
    // |point - (a + t(b-a))|² - (radiusA + t(radiusB-radiusA))².
    const quadratic = dx * dx + dy * dy - dr * dr;
    const linear = -2 * (px * dx + py * dy + a.radius * dr);
    const constant = px * px + py * py - a.radius * a.radius;
    if (constant <= 0 || quadratic + linear + constant <= 0) return true;
    if (quadratic > 0) {
      const t = Math.max(0, Math.min(1, -linear / (2 * quadratic)));
      if ((quadratic * t + linear) * t + constant <= 0) return true;
    }
  }
  return false;
}

export function coverageBounds(coverage: EraserCoverage): Rect | undefined {
  if (coverage.points.length === 0) return undefined;
  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (const point of coverage.points) {
    left = Math.min(left, point.x - point.radius);
    top = Math.min(top, point.y - point.radius);
    right = Math.max(right, point.x + point.radius);
    bottom = Math.max(bottom, point.y + point.radius);
  }
  return { x: left, y: top, w: right - left, h: bottom - top };
}

/** Geometric ellipse envelope; paper grain and pixel antialiasing are not hit-test geometry. */
export function dabContainsPoint(dab: Dab, point: Vec): boolean {
  if (dab.alpha <= 0) return false;
  const cosine = Math.cos(dab.angle);
  const sine = Math.sin(dab.angle);
  const dx = point.x - dab.x;
  const dy = point.y - dab.y;
  return (
    Math.hypot(
      (dx * cosine + dy * sine) / Math.max(0.35, dab.rx),
      (dy * cosine - dx * sine) / Math.max(0.35, dab.ry),
    ) <= 1
  );
}

export function visibleStrokeContainsPoint(
  dabs: readonly Dab[],
  erasures: readonly EraserCoverage[],
  point: Vec,
): boolean {
  return (
    !erasures.some((coverage) => coverageContainsPoint(coverage, point)) &&
    dabs.some((dab) => dabContainsPoint(dab, point))
  );
}

/** Minimum of distance(point, center(t)) - radius(t), t in [0, 1]. */
function segmentDiskDistance(point: Vec, a: EraserDisk, b: EraserDisk): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy);
  const dr = b.radius - a.radius;
  const ends = Math.min(dist(point, a) - a.radius, dist(point, b) - b.radius);
  // One endpoint disk contains the entire sweep in these cases.
  if (length === 0 || Math.abs(dr) >= length) return ends;
  const px = point.x - a.x;
  const py = point.y - a.y;
  const along = (px * dx + py * dy) / length;
  const across = Math.abs(px * dy - py * dx) / length;
  const offset = (dr * across) / Math.sqrt(length * length - dr * dr);
  const t = Math.max(0, Math.min(1, (along + offset) / length));
  return Math.min(ends, Math.hypot(px - dx * t, py - dy * t) - a.radius - dr * t);
}

/** Exact exterior distance; negative values identify a disk covering the point. */
function distanceLowerBound(coverage: EraserCoverage, point: Vec): number {
  let nearest = Number.POSITIVE_INFINITY;
  for (let i = 0; i < coverage.points.length; i++) {
    const a = coverage.points[i];
    const b = coverage.points[i + 1] ?? a;
    nearest = Math.min(nearest, segmentDiskDistance(point, a, b));
  }
  return nearest;
}

/** Radius of a disk around `point` known to be contained in the sweep. */
function coveredRadius(coverage: EraserCoverage, point: Vec): number {
  return -distanceLowerBound(coverage, point);
}

/** Each segment's swept disks form a convex set. Cover both endpoint disks to cover it. */
function coverageAlreadyErased(
  incoming: EraserCoverage,
  masks: readonly EraserCoverage[],
): boolean {
  return incoming.points.every((a, index) => {
    const b = incoming.points[index + 1] ?? a;
    return masks.some((mask) =>
      mask.points.some((start, i) => {
        const segment = { points: [start, mask.points[i + 1] ?? start] };
        return coveredRadius(segment, a) >= a.radius && coveredRadius(segment, b) >= b.radius;
      }),
    );
  });
}

function intersection(a: Rect, b: Rect): Rect | undefined {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.w, b.x + b.w);
  const bottom = Math.min(a.y + a.h, b.y + b.h);
  return right < x || bottom < y ? undefined : { x, y, w: right - x, h: bottom - y };
}

/**
 * Conservative footprint hit query after prior erasures. Subdivision stops at
 * `tolerance` ink units; a remaining ambiguous boundary cell counts as a hit.
 * This can include boundary-only contacts or slivers no larger than that cell,
 * but does not miss a visible intersection. It queries the filled dab envelope,
 * not a centerline or the grain's individual alpha holes.
 */
export function hitVisibleStroke(
  dabs: readonly Dab[],
  erasures: readonly EraserCoverage[],
  incoming: EraserCoverage,
  tolerance = 0.25,
): boolean {
  if (!Number.isFinite(tolerance) || tolerance <= 0)
    throw new RangeError("Hit tolerance must be positive and finite");
  const incomingBounds = coverageBounds(incoming);
  if (!incomingBounds) return false;
  if (coverageAlreadyErased(incoming, erasures)) return false;
  for (const dab of dabs) {
    if (dab.alpha <= 0) continue;
    const rx = Math.max(0.35, dab.rx);
    const ry = Math.max(0.35, dab.ry);
    const cosine = Math.cos(dab.angle);
    const sine = Math.sin(dab.angle);
    const hx = Math.hypot(rx * cosine, ry * sine);
    const hy = Math.hypot(rx * sine, ry * cosine);
    const bounds = intersection(
      { x: dab.x - hx, y: dab.y - hy, w: 2 * hx, h: 2 * hy },
      incomingBounds,
    );
    if (!bounds) continue;
    const masks = erasures.filter((mask) => {
      const maskBounds = coverageBounds(mask);
      return maskBounds !== undefined && intersection(bounds, maskBounds) !== undefined;
    });
    const pending = [bounds];
    while (pending.length > 0) {
      const cell = pending.pop() as Rect;
      const center = { x: cell.x + cell.w / 2, y: cell.y + cell.h / 2 };
      const radius = Math.hypot(cell.w, cell.h) / 2;
      const dx = center.x - dab.x;
      const dy = center.y - dab.y;
      const ellipseDistance = Math.hypot(
        (dx * cosine + dy * sine) / rx,
        (dy * cosine - dx * sine) / ry,
      );
      if (ellipseDistance - radius / Math.min(rx, ry) > 1) continue;
      if (distanceLowerBound(incoming, center) > radius) continue;
      if (masks.some((mask) => coveredRadius(mask, center) >= radius)) continue;
      if (
        ellipseDistance <= 1 &&
        coverageContainsPoint(incoming, center) &&
        !masks.some((mask) => coverageContainsPoint(mask, center))
      )
        return true;
      if (Math.hypot(cell.w, cell.h) <= tolerance) return true;
      // Bisect the longest dimension: no duplicate zero-width subdivisions.
      if (cell.w >= cell.h) {
        const half = cell.w / 2;
        pending.push({ ...cell, w: half }, { ...cell, x: cell.x + half, w: half });
      } else {
        const half = cell.h / 2;
        pending.push({ ...cell, h: half }, { ...cell, y: cell.y + half, h: half });
      }
    }
  }
  return false;
}
