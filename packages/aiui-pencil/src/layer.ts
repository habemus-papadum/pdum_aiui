/**
 * layer.ts — a raster tile anchored somewhere in canvas CSS-pixel space.
 *
 * The surface's three tiers (settled bitmap, retained tiles, live wet buffers)
 * are all `Layer`s: an offscreen canvas plus the canvas-space CSS-px offset of
 * its own (0, 0). `makeLayer`/`growLayer`/`clearLayer` are the only ways they
 * are allocated, resized, and wiped; all are pure DOM-canvas helpers with no
 * reference to surface state.
 */

import type { Rect } from "./geom";

export interface Layer {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  /** Canvas-space CSS px of this layer's own (0, 0). */
  ox: number;
  oy: number;
  w: number;
  h: number;
}

export function makeLayer(rect: Rect, dpr: number): Layer {
  const w = Math.max(1, Math.ceil(rect.w));
  const h = Math.max(1, Math.ceil(rect.h));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(w * dpr));
  canvas.height = Math.max(1, Math.round(h * dpr));
  const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { canvas, ctx, ox: Math.floor(rect.x), oy: Math.floor(rect.y), w, h };
}

/** Grow a layer to contain `rect`, preserving what is already drawn on it. */
export function growLayer(layer: Layer, rect: Rect, dpr: number): Layer {
  const x0 = Math.min(layer.ox, Math.floor(rect.x));
  const y0 = Math.min(layer.oy, Math.floor(rect.y));
  const x1 = Math.max(layer.ox + layer.w, Math.ceil(rect.x + rect.w));
  const y1 = Math.max(layer.oy + layer.h, Math.ceil(rect.y + rect.h));
  if (
    x0 === layer.ox &&
    y0 === layer.oy &&
    x1 === layer.ox + layer.w &&
    y1 === layer.oy + layer.h
  ) {
    return layer;
  }
  // Grow generously — a stroke that is growing will keep growing, and reallocating
  // per frame would be the whole cost of the surface.
  const pad = 64;
  const grown = makeLayer(
    { x: x0 - pad, y: y0 - pad, w: x1 - x0 + pad * 2, h: y1 - y0 + pad * 2 },
    dpr,
  );
  grown.ctx.drawImage(layer.canvas, layer.ox - grown.ox, layer.oy - grown.oy, layer.w, layer.h);
  return grown;
}

export function clearLayer(layer: Layer): void {
  layer.ctx.save();
  layer.ctx.setTransform(1, 0, 0, 1, 0, 0);
  layer.ctx.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
  layer.ctx.restore();
}
