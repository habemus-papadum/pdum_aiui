/**
 * stamp.ts — dabs → pixels. The rasteriser that turns a stroke's planned dabs
 * into coverage on a {@link Layer}, plus the geometry (`boundsOfDabs`) and the
 * bounds consumed by the canvas view.
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

/** The axis-aligned box a rotated ellipse actually covers. */
function dabBounds(dab: Dab, widthScale: number): Rect {
  const rx = Math.max(0.35, dab.rx * widthScale);
  const ry = Math.max(0.35, dab.ry * widthScale);
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
): void {
  const ctx = layer.ctx;
  const paint = heat(color, CHARGE_GLOW * style.glow);
  ctx.save();
  ctx.translate(-layer.ox, -layer.oy);
  ctx.fillStyle = paint;
  for (let i = from; i < to; i++) {
    const dab = dabs[i];
    ctx.globalAlpha = Math.min(1, dab.alpha);
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
  if (style.hollow > 0) {
    // Subtract the union after stamping the entire stroke, so overlapping dabs
    // cannot fill one another's openings. This only alters the display tile.
    ctx.globalCompositeOperation = "destination-out";
    ctx.globalAlpha = 1;
    ctx.beginPath();
    for (let i = from; i < to; i++) {
      const dab = dabs[i];
      if (dab.alpha <= 0) continue;
      const rx = Math.max(0.35, dab.rx * style.widthScale) * style.hollow * 0.72;
      const ry = Math.max(0.35, dab.ry * style.widthScale) * style.hollow * 0.72;
      ctx.moveTo(dab.x + rx * Math.cos(dab.angle), dab.y + rx * Math.sin(dab.angle));
      ctx.ellipse(dab.x, dab.y, rx, ry, dab.angle, 0, Math.PI * 2);
      ctx.closePath();
    }
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
