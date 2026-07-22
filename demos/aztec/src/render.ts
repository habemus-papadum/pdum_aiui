/**
 * render.ts — the imperative canvas-2D island's drawing code (disposable).
 *
 * The canvas element and its context are durable (created once in store.ts and
 * adopted by the component); this module is only the *how to paint a frame*
 * logic, so a hot edit to colors or the arctic overlay redraws the current
 * tiling without disturbing any durable state. The reactive→imperative bridge
 * (a graph effect) calls `draw` whenever the playhead, the circle toggle, or
 * the frame ring changes.
 */

import { COLOR } from "./palette";
import type { ShuffleFrame } from "./types";
import { EMPTY, N, S } from "./types";

const BG = "#0e1119";
const CIRCLE = "#e8e8ea";
const GAP = 0.08; // fraction of a cell left as a seam between dominoes (brickwork)

export interface DrawOptions {
  showCircle: boolean;
}

/** Paint one frame, letterboxed into the canvas so the diamond stays centered. */
export function draw(
  ctx: CanvasRenderingContext2D,
  frame: ShuffleFrame | undefined,
  opts: DrawOptions,
): void {
  const { canvas } = ctx;
  const px = canvas.width;
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, px, px);
  if (!frame || frame.size === 0) return;

  const { size, grid } = frame;
  const cell = px / size;
  const at = (r: number, c: number) => grid[r * size + c];

  // Each domino is drawn once, from its top-left (anchor) cell. Horizontal
  // dominoes (N/S) extend right; vertical (E/W) extend down. We inset by a
  // seam so neighbours read as separate bricks — the arctic brickwork.
  const inset = cell * GAP;
  const rect = (x: number, y: number, w: number, h: number, color: string) => {
    ctx.fillStyle = color;
    ctx.fillRect(x + inset, y + inset, w - 2 * inset, h - 2 * inset);
  };
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const t = at(r, c);
      if (t === EMPTY) continue;
      const horizontal = t === N || t === S;
      // Draw each domino once, from its anchor (left cell of a horizontal pair,
      // top cell of a vertical one).
      if (horizontal) {
        if (!isAnchorHoriz(grid, size, r, c, t)) continue;
        rect(c * cell, r * cell, 2 * cell, cell, COLOR[t as 1 | 2 | 3 | 4]);
      } else {
        if (!isAnchorVert(grid, size, r, c, t)) continue;
        rect(c * cell, r * cell, cell, 2 * cell, COLOR[t as 1 | 2 | 3 | 4]);
      }
    }
  }

  if (opts.showCircle) {
    // Arctic circle: radius n/√2 in cell units, about the grid centre.
    const n = size / 2;
    const center = px / 2;
    const radius = (n / Math.SQRT2) * cell;
    ctx.save();
    ctx.strokeStyle = CIRCLE;
    ctx.globalAlpha = 0.9;
    ctx.lineWidth = Math.max(1.5, cell * 0.12);
    ctx.setLineDash([cell * 0.5, cell * 0.5]);
    ctx.beginPath();
    ctx.arc(center, center, radius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
}

// A horizontal domino occupies (r,c),(r,c+1); its anchor is the left cell, i.e.
// the left neighbour is not part of the same-type run at even offset. Because
// two horizontal dominoes of the same type can abut, "same label to the left"
// is not enough — pair cells up from the diamond's left edge in each row.
function isAnchorHoriz(grid: number[], size: number, r: number, c: number, t: number): boolean {
  // Walk left counting contiguous same-type cells; anchor iff even count so far.
  let run = 0;
  let cc = c - 1;
  while (cc >= 0 && grid[r * size + cc] === t) {
    run++;
    cc--;
  }
  return run % 2 === 0;
}

function isAnchorVert(grid: number[], size: number, r: number, c: number, t: number): boolean {
  let run = 0;
  let rr = r - 1;
  while (rr >= 0 && grid[rr * size + c] === t) {
    run++;
    rr--;
  }
  return run % 2 === 0;
}
