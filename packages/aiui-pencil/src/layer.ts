/** A disposable raster tile in ink coordinates. */

import type { Rect } from "./geom";

export interface Layer {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  /** Stroke-local ink coordinates of this layer's own (0, 0). */
  ox: number;
  oy: number;
  w: number;
  h: number;
}

export function makeLayer(rect: Rect, dpr: number): Layer {
  const w = Math.max(1, Math.ceil(rect.x + rect.w) - Math.floor(rect.x));
  const h = Math.max(1, Math.ceil(rect.y + rect.h) - Math.floor(rect.y));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(w * dpr));
  canvas.height = Math.max(1, Math.round(h * dpr));
  const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { canvas, ctx, ox: Math.floor(rect.x), oy: Math.floor(rect.y), w, h };
}
