/**
 * spline.ts — centripetal Catmull-Rom interpolation that BREAKS at cusps.
 * Playbook layer 1: pure, realm-free.
 *
 * Catmull-Rom because it passes *through* its control points: the pen went where
 * it went, and a curve that merely approaches the samples is a curve that has
 * quietly moved the user's line. (Bézier smoothing of the kind the old ink
 * surface does — raw samples as control points, midpoints as endpoints — does
 * exactly that, which is part of why it rounds letters off.)
 *
 * **Centripetal** (α = 0.5), specifically, and this is not a detail. The uniform
 * parameterization (α = 0) overshoots and self-intersects when consecutive
 * samples are unevenly spaced — which is to say, whenever the pen changes speed,
 * which is to say, constantly. The classic artifact is a little loop or a bulge
 * on the outside of a fast turn, and it is unmistakable and awful once you know
 * to look for it. Centripetal is provably free of both cusps and self-
 * intersections within a segment (Yuksel et al., 2011), and costs one `sqrt` per
 * knot.
 *
 * And then, having chosen a scheme that never produces a cusp, we put the cusps
 * back deliberately — at exactly the points `corners.ts` identified, and nowhere
 * else. That is the whole design in one sentence: **smooth by default, sharp on
 * purpose.**
 */

import { lerp, lerpAngle, type Vec } from "./geom";
import type { PenSample } from "./telemetry";

/**
 * Interpolate every field of a sample. Position and the scalars ride along
 * linearly; azimuth takes the short way around the circle (a pen crossing due
 * north must not spin 359° the other way — the dab would visibly cartwheel).
 */
export function blendSample(a: PenSample, b: PenSample, t: number): PenSample {
  return {
    x: lerp(a.x, b.x, t),
    y: lerp(a.y, b.y, t),
    t: lerp(a.t, b.t, t),
    pressure: lerp(a.pressure, b.pressure, t),
    altitude: lerp(a.altitude, b.altitude, t),
    azimuth: lerpAngle(a.azimuth, b.azimuth, t),
    twist: lerp(a.twist, b.twist, t),
    kind: a.kind,
    width: lerp(a.width, b.width, t),
    height: lerp(a.height, b.height, t),
  };
}

/**
 * Evaluate the centripetal Catmull-Rom curve on the segment `p1 → p2`, using
 * `p0` and `p3` as the shaping neighbours, at parameter `s` in [0, 1].
 *
 * Barry-Goldman pyramidal form: three lerps, then two, then one. Knot spacing is
 * `|Δp|^α` — that is the "centripetal" part, and the reason the whole thing is
 * well-behaved.
 *
 * Coincident neighbours (a stationary pen emitting duplicate samples) collapse a
 * knot interval to zero and would divide by it; those intervals are skipped,
 * which degrades the curve gracefully toward a straight line exactly where the
 * pen was not moving anyway.
 */
export function catmullRom(p0: Vec, p1: Vec, p2: Vec, p3: Vec, s: number, alpha = 0.5): Vec {
  const knot = (a: Vec, b: Vec, t: number): number => t + Math.hypot(b.x - a.x, b.y - a.y) ** alpha;
  const t0 = 0;
  const t1 = knot(p0, p1, t0);
  const t2 = knot(p1, p2, t1);
  const t3 = knot(p2, p3, t2);

  // A degenerate middle interval means p1 and p2 coincide: there is no segment.
  if (t2 === t1) {
    return { x: p1.x, y: p1.y };
  }
  const t = lerp(t1, t2, s);

  const a1 = span(p0, p1, t0, t1, t);
  const a2 = span(p1, p2, t1, t2, t);
  const a3 = span(p2, p3, t2, t3, t);
  const b1 = span(a1, a2, t0, t2, t);
  const b2 = span(a2, a3, t1, t3, t);
  return span(b1, b2, t1, t2, t);
}

/** One rung of the Barry-Goldman pyramid; a zero-width knot interval passes `a` through. */
function span(a: Vec, b: Vec, ta: number, tb: number, t: number): Vec {
  if (tb === ta) {
    return a;
  }
  const u = (t - ta) / (tb - ta);
  return { x: lerp(a.x, b.x, u), y: lerp(a.y, b.y, u) };
}

export interface DensifyConfig {
  /**
   * The longest straight step (px) the densified polyline may take. Smaller
   * means a more faithful curve and more points. ~2px is well under what the
   * eye resolves at typical scale, and the arc-length resampler downstream is
   * going to re-space everything anyway — this only has to be fine enough that
   * the *shape* is right.
   */
  maxStep: number;
  /** Hard ceiling on subdivisions per segment; a runaway guard, not a knob. */
  maxSubdivisions?: number;
}

/**
 * Turn the sample list into a dense polyline that follows the centripetal
 * Catmull-Rom curve through it, **splitting into independent runs at every
 * cusp** so a corner stays a corner.
 *
 * The runs share their cusp point — it is the last point of one run and the
 * first of the next — so the path stays continuous (C⁰) while its tangent does
 * not (no C¹). That is precisely what a pen does when it reverses.
 *
 * Each run gets reflected phantom control points at its ends (`2·p₀ − p₁`), which
 * makes the curve leave and enter the run along the run's own direction. The
 * naive alternative — duplicating the endpoint — flattens the curve into the
 * endpoint and produces a visible little straightening at the start of every
 * stroke.
 */
export function densify(
  samples: readonly PenSample[],
  cusps: readonly boolean[],
  config: DensifyConfig,
): PenSample[] {
  if (samples.length < 2) {
    return [...samples];
  }
  const maxSubdivisions = config.maxSubdivisions ?? 32;
  const out: PenSample[] = [];

  for (const run of splitAtCusps(samples, cusps)) {
    if (run.length === 1) {
      pushDeduped(out, run[0]);
      continue;
    }
    for (let i = 0; i < run.length - 1; i++) {
      const p1 = run[i];
      const p2 = run[i + 1];
      const p0 = i > 0 ? run[i - 1] : reflect(p1, p2);
      const p3 = i + 2 < run.length ? run[i + 2] : reflect(p2, p1);

      const chord = Math.hypot(p2.x - p1.x, p2.y - p1.y);
      const steps = Math.min(
        maxSubdivisions,
        Math.max(1, Math.ceil(chord / Math.max(0.01, config.maxStep))),
      );

      pushDeduped(out, p1);
      for (let k = 1; k < steps; k++) {
        const s = k / steps;
        const position = catmullRom(p0, p1, p2, p3, s);
        // Position comes from the spline; everything else rides along linearly.
        // The pen's pressure at a point the spline invented is, by definition,
        // an interpolation — there is nothing better to say about it.
        const blended = blendSample(p1, p2, s);
        pushDeduped(out, { ...blended, x: position.x, y: position.y });
      }
    }
    pushDeduped(out, run[run.length - 1]);
  }
  return out;
}

/** Split into runs that share their cusp points (the corner belongs to both sides). */
function splitAtCusps(samples: readonly PenSample[], cusps: readonly boolean[]): PenSample[][] {
  const runs: PenSample[][] = [];
  let current: PenSample[] = [samples[0]];
  for (let i = 1; i < samples.length; i++) {
    current.push(samples[i]);
    if (cusps[i] === true && i < samples.length - 1) {
      runs.push(current);
      current = [samples[i]]; // the cusp starts the next run too
    }
  }
  runs.push(current);
  return runs;
}

/** The phantom control point beyond `a`, mirroring `b` through it. */
function reflect(a: Vec, b: Vec): Vec {
  return { x: 2 * a.x - b.x, y: 2 * a.y - b.y };
}

/** Append unless it duplicates the last point exactly (run joins would double up). */
function pushDeduped(out: PenSample[], sample: PenSample): void {
  const last = out[out.length - 1];
  if (last !== undefined && last.x === sample.x && last.y === sample.y && last.t === sample.t) {
    return;
  }
  out.push(sample);
}
