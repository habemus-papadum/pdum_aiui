/**
 * corners.ts — cusp detection. Playbook layer 1: pure, realm-free.
 *
 * This is the module that keeps a `k` from becoming an `l`.
 *
 * Any smoothing scheme worth using rounds corners — that is what smoothing *is*.
 * For a lasso around a chart that is exactly right. For handwriting it is
 * destruction: the sharp reversals in `k`, `x`, `v`, `z`, and every capital `A`
 * are not noise to be filtered out, they are the letter. The existing ink
 * surface has no notion of this at all (its midpoint-quadratic scheme rounds
 * every corner by construction), which is the single clearest reason handwriting
 * looks wrong in it today.
 *
 * So before we spline anything, we find the corners and mark them, and the
 * spline is then told to *break* there rather than smooth through. The two-line
 * summary of the whole approach: **smooth the curves, keep the corners.**
 *
 * The measurement is turning angle over an arc-length window, not over adjacent
 * samples — and that distinction is the whole trick. Adjacent samples are
 * dominated by jitter and by however fast the pen happened to be moving; a
 * genuine corner is a direction change that survives being looked at from a
 * fixed distance *along the paper* on either side. Sampling rate drops out.
 */

import { dist, type Vec } from "./geom";

export interface CuspConfig {
  /**
   * How far along the stroke (px) to look on each side of a candidate. Too small
   * and jitter reads as corners; too large and a genuine sharp letter-corner
   * gets averaged into a curve. Around 4-8px suits handwriting at typical
   * screen scale.
   */
  window: number;
  /**
   * The turn (radians) that counts as a corner. ~π/3 (60°) is a sane start:
   * comfortably past what a fast circle turns through in one window, comfortably
   * short of the ~π a pen-reversal produces.
   */
  threshold: number;
}

/**
 * The angle between the incoming and outgoing directions at `points[i]`,
 * measured across an arc-length `window` on each side. Radians, 0 (dead straight)
 * to π (a full reversal). Always positive — which way it turns is not our
 * business, only how hard.
 *
 * Returns 0 when there is not enough stroke on one side to look across: the ends
 * of a stroke are not corners, they are ends.
 */
export function turnAt(points: readonly Vec[], i: number, window: number): number {
  const back = walkBack(points, i, window);
  const forward = walkForward(points, i, window);
  if (back === undefined || forward === undefined) {
    return 0;
  }
  const inX = points[i].x - back.x;
  const inY = points[i].y - back.y;
  const outX = forward.x - points[i].x;
  const outY = forward.y - points[i].y;
  const inLen = Math.hypot(inX, inY);
  const outLen = Math.hypot(outX, outY);
  if (inLen === 0 || outLen === 0) {
    return 0;
  }
  // atan2 of the cross and dot products: numerically better behaved than acos of
  // a normalized dot, which loses all its precision at exactly the shallow angles
  // we most need to distinguish from zero.
  const cross = inX * outY - inY * outX;
  const dot = inX * outX + inY * outY;
  return Math.abs(Math.atan2(cross, dot));
}

/**
 * Which points are corners. Returns a boolean per input point (never true at the
 * endpoints).
 *
 * Adjacent candidates are collapsed to the sharpest — a real corner drawn at a
 * high sample rate trips the threshold at several consecutive samples, and
 * breaking the spline at each of them would replace one corner with a short
 * straight-line chamfer, which looks like a mistake and is one.
 */
export function detectCusps(points: readonly Vec[], config: CuspConfig): boolean[] {
  const flags = new Array<boolean>(points.length).fill(false);
  if (points.length < 3) {
    return flags;
  }
  const turns = points.map((_, i) => turnAt(points, i, config.window));

  let i = 1;
  while (i < points.length - 1) {
    if (turns[i] < config.threshold) {
      i++;
      continue;
    }
    // A run of over-threshold samples is ONE corner. Take its sharpest point.
    let best = i;
    let j = i;
    while (j < points.length - 1 && turns[j] >= config.threshold) {
      if (turns[j] > turns[best]) {
        best = j;
      }
      j++;
    }
    flags[best] = true;
    i = j;
  }
  return flags;
}

// ── walking the polyline by distance, not by index ───────────────────────────

/** The point `window` px back along the stroke from `i`, interpolated. */
function walkBack(points: readonly Vec[], i: number, window: number): Vec | undefined {
  let remaining = window;
  for (let k = i; k > 0; k--) {
    const step = dist(points[k], points[k - 1]);
    if (step >= remaining) {
      const t = step === 0 ? 0 : remaining / step;
      return {
        x: points[k].x + (points[k - 1].x - points[k].x) * t,
        y: points[k].y + (points[k - 1].y - points[k].y) * t,
      };
    }
    remaining -= step;
  }
  return undefined; // ran off the start: not enough stroke to judge
}

/** The point `window` px forward along the stroke from `i`, interpolated. */
function walkForward(points: readonly Vec[], i: number, window: number): Vec | undefined {
  let remaining = window;
  for (let k = i; k < points.length - 1; k++) {
    const step = dist(points[k], points[k + 1]);
    if (step >= remaining) {
      const t = step === 0 ? 0 : remaining / step;
      return {
        x: points[k].x + (points[k + 1].x - points[k].x) * t,
        y: points[k].y + (points[k + 1].y - points[k].y) * t,
      };
    }
    remaining -= step;
  }
  return undefined; // ran off the end
}
