/**
 * circle.ts — the math of "how well did I draw a circle". Playbook layer 1:
 * pure, realm-free (no DOM, no solid-js, no time), exhaustively tested.
 *
 * A stroke is a list of points. Everything the app reports about it is derived
 * here by closed-form geometry — no fitting library, no iteration:
 *
 *  - {@link fitCircle} — the best-fit circle by Kåsa's algebraic method (one
 *    3×3 linear solve). Its centre and radius are the yardstick everything else
 *    measures against.
 *  - {@link fitEllipseMoments} — orientation and eccentricity from the stroke's
 *    second central moments (a 2×2 symmetric eigenproblem, closed form). This is
 *    what turns "my circle is a bit of an egg" into a number.
 *  - {@link summarize} — the whole readout bundle, including a single 0–100
 *    {@link CircleStats.score | score}.
 *
 * The scale convention: a canvas is y-DOWN, so a clockwise loop has negative
 * shoelace area. Sizes take absolute value; only {@link sweepDeg} keeps a sign
 * long enough to know a full turn from a scribble, then reports its magnitude.
 */

import { polygonArea, polylineLength, type Vec } from "@habemus-papadum/aiui-pencil";

export type { Vec };

/** The best-fit circle: centre, radius, and how far the points stray from it. */
export interface CircleFit {
  cx: number;
  cy: number;
  /** Best-fit radius, px. */
  r: number;
  /** RMS of |distance-to-centre − r| over the points, px. The wobble. */
  radialRms: number;
}

/** The moment ellipse: orientation and shape, scaled to the fit circle. */
export interface EllipseFit {
  /** Semi-major axis, px (scaled so the geometric mean of the axes is `r`). */
  major: number;
  /** Semi-minor axis, px. */
  minor: number;
  /** minor / major, in [0, 1]. 1 is a perfect circle. */
  axisRatio: number;
  /** √(1 − axisRatio²), in [0, 1). 0 is a circle, → 1 is a line. */
  eccentricity: number;
  /** Orientation of the major axis, degrees in (−90, 90], measured from +x. */
  tiltDeg: number;
}

/** Everything the app shows for one stroke. `null` from {@link summarize} when
 * the stroke is too short or degenerate to measure. */
export interface CircleStats {
  pointCount: number;
  center: Vec;
  /** Best-fit radius, px. */
  radius: number;
  /** RMS radial deviation, px. */
  radialRms: number;
  /** radialRms / radius — scale-free wobble. */
  radialCv: number;
  eccentricity: number;
  axisRatio: number;
  major: number;
  minor: number;
  tiltDeg: number;
  /** Distance between the first and last point, px — how well it closed. */
  closureGap: number;
  /** closureGap / radius. */
  closureRatio: number;
  /** Total absolute turning about the centre, degrees. ~360 for one clean loop. */
  sweepDeg: number;
  /** Drawn arc length, px (the pen's path, open). */
  pathLength: number;
  /** Enclosed area of the closed polygon, px². */
  area: number;
  /** Shape score in [0, 1]: how tightly the points hug ONE circle, from the
   * best-fit radial CV. 1 = a perfect circle; an ellipse or a wobble drops it. */
  roundness: number;
  /** 0–100 overall: roundness tempered by how complete a single loop it was. */
  score: number;
}

function dist(a: Vec, b: Vec): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function centroid(points: readonly Vec[]): Vec {
  let sx = 0;
  let sy = 0;
  for (const p of points) {
    sx += p.x;
    sy += p.y;
  }
  const n = points.length || 1;
  return { x: sx / n, y: sy / n };
}

/**
 * Solve a 3×3 linear system by Cramer's rule. Returns `null` if the matrix is
 * singular (collinear points give a degenerate circle fit). `m` is row-major.
 */
function solve3(m: readonly number[][], b: readonly number[]): [number, number, number] | null {
  const det = (a: readonly number[][]): number =>
    a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1]) -
    a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0]) +
    a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0]);
  const d = det(m);
  if (Math.abs(d) < 1e-9) {
    return null;
  }
  const col = (i: number): number[][] => m.map((row, r) => row.map((v, c) => (c === i ? b[r] : v)));
  return [det(col(0)) / d, det(col(1)) / d, det(col(2)) / d];
}

/**
 * Best-fit circle by Kåsa's algebraic method: minimise
 * Σ(x² + y² + Dx + Ey + F)² over D, E, F — a single linear least-squares solve,
 * exact for points that lie on a circle. Returns `null` for fewer than three
 * points or a collinear set.
 */
export function fitCircle(points: readonly Vec[]): CircleFit | null {
  if (points.length < 3) {
    return null;
  }
  let Sx = 0;
  let Sy = 0;
  let Sxx = 0;
  let Syy = 0;
  let Sxy = 0;
  let Sxg = 0;
  let Syg = 0;
  let Sg = 0;
  for (const p of points) {
    const g = p.x * p.x + p.y * p.y;
    Sx += p.x;
    Sy += p.y;
    Sxx += p.x * p.x;
    Syy += p.y * p.y;
    Sxy += p.x * p.y;
    Sxg += p.x * g;
    Syg += p.y * g;
    Sg += g;
  }
  const n = points.length;
  const sol = solve3(
    [
      [Sxx, Sxy, Sx],
      [Sxy, Syy, Sy],
      [Sx, Sy, n],
    ],
    [-Sxg, -Syg, -Sg],
  );
  if (sol === null) {
    return null;
  }
  const [D, E, F] = sol;
  const cx = -D / 2;
  const cy = -E / 2;
  const inside = cx * cx + cy * cy - F;
  if (inside <= 0) {
    return null;
  }
  const r = Math.sqrt(inside);
  let acc = 0;
  for (const p of points) {
    const dev = dist(p, { x: cx, y: cy }) - r;
    acc += dev * dev;
  }
  return { cx, cy, r, radialRms: Math.sqrt(acc / n) };
}

/**
 * Orientation and eccentricity from the second central moments of the point
 * cloud. The moment matrix `[[Sxx, Sxy], [Sxy, Syy]]` is 2×2 symmetric, so its
 * eigenvalues are closed form; their ratio is the shape's axis ratio and the
 * dominant eigenvector is the major axis. Axis lengths are reported scaled so
 * their geometric mean equals `radius`, keeping them in the same px world as
 * the fit circle. Returns `null` when the cloud has no spread.
 */
export function fitEllipseMoments(points: readonly Vec[], radius: number): EllipseFit | null {
  if (points.length < 3) {
    return null;
  }
  const c = centroid(points);
  let Sxx = 0;
  let Syy = 0;
  let Sxy = 0;
  for (const p of points) {
    const dx = p.x - c.x;
    const dy = p.y - c.y;
    Sxx += dx * dx;
    Syy += dy * dy;
    Sxy += dx * dy;
  }
  const n = points.length;
  Sxx /= n;
  Syy /= n;
  Sxy /= n;
  const half = (Sxx - Syy) / 2;
  const spread = Math.sqrt(half * half + Sxy * Sxy);
  const l1 = (Sxx + Syy) / 2 + spread; // larger eigenvalue (major)
  const l2 = (Sxx + Syy) / 2 - spread; // smaller (minor)
  if (l1 <= 0) {
    return null;
  }
  const axisRatio = Math.sqrt(Math.max(0, l2) / l1);
  const eccentricity = Math.sqrt(Math.max(0, 1 - axisRatio * axisRatio));
  // atan2(2·Sxy, Sxx−Syy) / 2 is the major-axis angle; fold to (−90, 90].
  let tiltDeg = (Math.atan2(2 * Sxy, Sxx - Syy) / 2) * (180 / Math.PI);
  if (tiltDeg <= -90) {
    tiltDeg += 180;
  } else if (tiltDeg > 90) {
    tiltDeg -= 180;
  }
  const g = axisRatio > 0 ? Math.sqrt(axisRatio) : 1;
  return {
    major: radius / g,
    minor: radius * g,
    axisRatio,
    eccentricity,
    tiltDeg,
  };
}

/**
 * Total absolute turning of the points about a centre, in degrees. Each step's
 * angular change is taken the short way around, summed with sign, and the
 * magnitude returned — one clean loop is ~360°, a back-and-forth scribble stays
 * near 0, an over-wound double loop approaches 720°.
 */
export function sweepDegrees(points: readonly Vec[], center: Vec): number {
  let net = 0;
  let prev = Math.atan2(points[0].y - center.y, points[0].x - center.x);
  for (let i = 1; i < points.length; i++) {
    const a = Math.atan2(points[i].y - center.y, points[i].x - center.x);
    let d = a - prev;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    net += d;
    prev = a;
  }
  return Math.abs(net) * (180 / Math.PI);
}

/**
 * The whole readout for one stroke. `null` when there are too few points, the
 * points are collinear, or the fit radius is non-positive — the caller shows an
 * empty panel rather than nonsense.
 *
 * The {@link CircleStats.score | score} multiplies two things a good circle
 * needs: the ROUNDNESS of the shape (how tightly every point hugs one best-fit
 * circle — the radial CV, which an egg fails because it strays from any circle)
 * and the COMPLETENESS of the loop (how close the total turning came to a
 * single 360°). Either failing pulls the score down, so a perfect half-circle
 * and a lumpy full circle both read as clearly imperfect, for different reasons
 * the panel spells out.
 */
export function summarize(points: readonly Vec[]): CircleStats | null {
  if (points.length < 3) {
    return null;
  }
  const fit = fitCircle(points);
  if (fit === null || fit.r <= 0) {
    return null;
  }
  const center = { x: fit.cx, y: fit.cy };
  const ellipse = fitEllipseMoments(points, fit.r);
  if (ellipse === null) {
    return null;
  }

  const pathLength = polylineLength(points);
  const closureGap = dist(points[0], points[points.length - 1]);
  const area = Math.abs(polygonArea(points));
  // Roundness from the best-fit radial CV: a true circle has CV 0 → 1.0; the
  // slope (2.9) is tuned so a clean hand circle (~2% CV) reads mid-90s and a
  // 2:1 egg (~16% CV) reads ~50 — the honest spread the isoperimetric quotient
  // failed to give (a 1.6:1 ellipse scores 0.92 there, indistinguishable from
  // a good circle).
  const radialCv = fit.radialRms / fit.r;
  const roundness = Math.max(0, 1 - 2.9 * radialCv);
  const sweepDeg = sweepDegrees(points, center);
  const completeness = Math.max(0, 1 - Math.abs(sweepDeg - 360) / 360);
  const score = Math.round(100 * roundness * completeness);

  return {
    pointCount: points.length,
    center,
    radius: fit.r,
    radialRms: fit.radialRms,
    radialCv,
    eccentricity: ellipse.eccentricity,
    axisRatio: ellipse.axisRatio,
    major: ellipse.major,
    minor: ellipse.minor,
    tiltDeg: ellipse.tiltDeg,
    closureGap,
    closureRatio: closureGap / fit.r,
    sweepDeg,
    pathLength,
    area,
    roundness,
    score,
  };
}

/** Sample `n` points of an ellipse — a test/demo helper, and the shape the unit
 * tests fit against to prove the recovery is exact. `phase` starts the sweep,
 * `turns` lets a test draw more or less than one loop. */
export function sampleEllipse(opts: {
  cx: number;
  cy: number;
  a: number;
  b: number;
  n: number;
  angle?: number;
  phase?: number;
  turns?: number;
}): Vec[] {
  const { cx, cy, a, b, n, angle = 0, phase = 0, turns = 1 } = opts;
  const ca = Math.cos(angle);
  const sa = Math.sin(angle);
  const out: Vec[] = [];
  for (let i = 0; i < n; i++) {
    // Non-duplicating: span [phase, phase + turns·2π) so a full turn does NOT
    // repeat its start point — a repeated sample skews the moment ellipse, and
    // eccentricity is steep enough near a circle to make that visible.
    const t = phase + (turns * 2 * Math.PI * i) / n;
    const ex = a * Math.cos(t);
    const ey = b * Math.sin(t);
    out.push({ x: cx + ex * ca - ey * sa, y: cy + ex * sa + ey * ca });
  }
  return out;
}
