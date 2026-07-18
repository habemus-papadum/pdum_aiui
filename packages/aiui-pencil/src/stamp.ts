/**
 * stamp.ts — dabs → pixels. The rasteriser that turns a stroke's planned dabs
 * into coverage on a {@link Layer}, plus the geometry (`boundsOfDabs`) and the
 * warp-tile cache key (`styleKey`) the surface stamps against.
 *
 * Grain is applied ONCE, at the end, over accumulated alpha — never per dab —
 * so the wet stroke and the tile it bakes into are the same pixels. That
 * invariant lives in `stampDabs`/`applyGrain` and must stay one unit.
 */

import type { Dab } from "./dabs";
import { CHARGE_GLOW, type FadeStyle, heat } from "./fade";
import type { Rect } from "./geom";
import type { GrainCache } from "./grain";
import type { Layer } from "./layer";
import type { PencilParams } from "./pencil";
import type { Tool } from "./stroke-types";

/**
 * How many dabs at the tail of a live stroke are NOT yet safe to bake.
 *
 * Cusp detection looks *forward* along the stroke, so the corner flags — and
 * therefore the spline, and therefore the dabs — near the leading end can still
 * change when the next sample lands. Baking those into the wet buffer would
 * freeze a decision the pipeline has not finished making. So the tail is redrawn
 * every frame into a scratch and only the stable prefix is baked. The size is
 * derived from the cusp window (in px) over the dab spacing (in px), plus slack.
 */
export function unstableTail(params: PencilParams): number {
  const spacing = Math.max(0.05, params.size * params.spacing);
  return Math.ceil((params.cuspWindow + 2 * params.maxStep) / spacing) + 8;
}

/** Warp-style quantisation: re-stamp only when the stretch/glow visibly moves. */
const STYLE_STEP = 0.05;

function quantize(value: number): string {
  return (Math.round(value / STYLE_STEP) * STYLE_STEP).toFixed(2);
}

/**
 * A retained tile's warp-cache key: the width-stretch and glow quantised to
 * STYLE_STEP, so a tile re-bakes only when the warp visibly moves. The `"full"`
 * sentinel for an un-warped bake stays in the surface's `tileFor`.
 */
export function styleKey(style: FadeStyle): string {
  return `${quantize(style.widthScale)}:${quantize(style.glow)}`;
}

/** The axis-aligned box a rotated ellipse actually covers. */
function dabBounds(dab: Dab, widthScale: number): Rect {
  const rx = dab.rx * widthScale;
  const ry = dab.ry * widthScale;
  const c = Math.cos(dab.angle);
  const s = Math.sin(dab.angle);
  const hx = Math.hypot(rx * c, ry * s);
  const hy = Math.hypot(rx * s, ry * c);
  return { x: dab.x - hx, y: dab.y - hy, w: hx * 2, h: hy * 2 };
}

export function boundsOfDabs(dabs: readonly Dab[], widthScale = 1): Rect | undefined {
  if (dabs.length === 0) {
    return undefined;
  }
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  for (const dab of dabs) {
    const b = dabBounds(dab, widthScale);
    if (b.x < x0) x0 = b.x;
    if (b.y < y0) y0 = b.y;
    if (b.x + b.w > x1) x1 = b.x + b.w;
    if (b.y + b.h > y1) y1 = b.y + b.h;
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * How much harder an eraser bites than a pencil of the same dynamics.
 *
 * **Where the "one instrument" metaphor stops.** The eraser is the pencil turned
 * around: it keeps the instrument's *geometry* — pressure and tilt still set the
 * dab's radius and its ellipse, so you can erase with a fine point or scrub with
 * a laid-over edge. What it must not keep is the pencil's *density*. A stroke
 * lays graphite at `flow` (≈0.5), and the paper's tooth then eats holes in that;
 * mask with the result and a full-pressure pass over a line lifts about a third
 * of it and leaves the rest behind as speckle. Measured, the first time this was
 * driven in a browser: 38%.
 *
 * Two things fix it, and it is worth being precise about which does the work:
 *
 *  - **the tooth does not apply** (see {@link grainOf}) — that is the real fix,
 *    and it alone takes a firm pass from 38% to 97.7% of the ink under it;
 *  - **the bite** closes the last stubborn 2%, which is a visible ghost.
 *
 * The value is chosen so that the eraser is *definitive but still an instrument*:
 * at 1.6 a firm pass clears 99.9% of what is under it — at any speed, since the
 * dabs accumulate — while a feather-light pass clears only ~73%, along a path its
 * low pressure has already made narrower. So a light touch fades a stroke instead
 * of deleting it, which is a thing worth being able to do.
 */
const ERASE_BITE = 1.6;

/**
 * Stamp dabs onto a layer as **raw, ungrained** coverage.
 *
 * Grain is deliberately NOT applied here. It is applied once, at the end, over
 * the accumulated alpha — because that is the only way the wet stroke you are
 * watching and the baked tile it becomes are the *same pixels*. Grain the dabs
 * individually (or per frame-batch) and the two composite differently, and the
 * stroke visibly lightens the instant you lift the pen. It is a small pop, and it
 * is the kind of thing that makes a tool feel untrustworthy without anyone being
 * able to say why.
 */
export function stampDabs(
  layer: Layer,
  dabs: readonly Dab[],
  from: number,
  to: number,
  color: string,
  style: FadeStyle,
  tool: Tool = "draw",
): void {
  const ctx = layer.ctx;
  const paint = heat(color, CHARGE_GLOW * style.glow);
  const bite = tool === "erase" ? ERASE_BITE : 1;
  ctx.save();
  ctx.translate(-layer.ox, -layer.oy);
  ctx.fillStyle = paint;
  for (let i = from; i < to; i++) {
    const dab = dabs[i];
    ctx.globalAlpha = Math.min(1, dab.alpha * bite);
    ctx.beginPath();
    ctx.ellipse(
      dab.x,
      dab.y,
      Math.max(0.35, dab.rx * style.widthScale),
      Math.max(0.35, dab.ry * style.widthScale),
      dab.angle,
      0,
      Math.PI * 2,
    );
    ctx.fill();
  }
  ctx.restore();
}

/**
 * Multiply a layer's accumulated alpha by the paper's tooth.
 *
 * `destination-in` is the whole trick: it keeps the destination *scaled by the
 * source's alpha*, so a semi-transparent noise pattern eats coverage rather than
 * painting grey on top of it. And the fill is translated by the layer's canvas
 * origin, which is what pins the lattice to the PAGE rather than to the tile —
 * the difference between graphite catching on paper and a stroke wearing a
 * sticker of some noise.
 */
export function applyGrain(layer: Layer, cache: GrainCache, amount: number, scale: number): void {
  const pattern = cache.patternFor(layer.ctx, amount, scale);
  if (pattern === null) {
    return; // grain off: no mask pass at all
  }
  const ctx = layer.ctx;
  ctx.save();
  ctx.globalCompositeOperation = "destination-in";
  ctx.translate(-layer.ox, -layer.oy);
  ctx.fillStyle = pattern;
  ctx.fillRect(layer.ox, layer.oy, layer.w, layer.h);
  ctx.restore();
}

/**
 * The paper's tooth belongs to LAYING graphite, not to lifting it.
 *
 * A grained eraser mask has tooth-shaped holes in it, so it leaves behind, as
 * speckle, precisely the ink it was asked to remove. An eraser meets the paper
 * flat — so it erases flat, and the only thing that feathers its edge is the
 * falloff of its own dabs.
 */
export function grainOf(tool: Tool, params: PencilParams): number {
  return tool === "erase" ? 0 : params.grain;
}
