/**
 * card.tsx — the landing card (aiui-viz's DemoCard): a blurb and a LIVE,
 * self-contained preview. It sketches what the page is — an embedding map of
 * clustered points with a sweeping selection rectangle — from pure math on a
 * canvas: no DuckDB, no Mosaic, no store/graph (a landing mounts every app's
 * preview at once).
 */
import type { DemoCard } from "@habemus-papadum/aiui-viz";
import { onCleanup } from "solid-js";

const CW = 200;
const CH = 125;
const BG = "#0e1119";
const BOX = "#8ab4f8";
const COLORS = ["#e0576a", "#e28a3a", "#cdb04a", "#7cb84e", "#36b39e", "#4a86dd", "#9b6fdb"];

interface Dot {
  x: number;
  y: number;
  c: number;
}

// A deterministic little "embedding": gaussian clusters, one per color.
function makeDots(): Dot[] {
  let seed = 7;
  const rng = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  const gauss = () => (rng() + rng() + rng() + rng() - 2) / 2;
  const dots: Dot[] = [];
  for (let c = 0; c < COLORS.length; c++) {
    const cx = 20 + rng() * (CW - 40);
    const cy = 16 + rng() * (CH - 32);
    const sx = 6 + rng() * 10;
    const sy = 5 + rng() * 8;
    for (let i = 0; i < 90; i++) {
      dots.push({ x: cx + gauss() * sx, y: cy + gauss() * sy, c });
    }
  }
  return dots;
}

function Preview() {
  const canvas = document.createElement("canvas");
  canvas.width = CW;
  canvas.height = CH;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;
  const dots = makeDots();

  let raf = 0;
  let t = 0;
  const loop = (): void => {
    raf = requestAnimationFrame(loop);
    t += 0.008;
    // The sweeping selection box.
    const phase = (Math.sin(t) + 1) / 2;
    const bx = 18 + phase * (CW - 90);
    const by = 22 + ((Math.sin(t * 0.7) + 1) / 2) * (CH - 80);
    const bw = 62;
    const bh = 44;

    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, CW, CH);
    for (const d of dots) {
      const inside = d.x >= bx && d.x <= bx + bw && d.y >= by && d.y <= by + bh;
      ctx.globalAlpha = inside ? 0.95 : 0.4;
      ctx.fillStyle = COLORS[d.c];
      ctx.fillRect(d.x, d.y, 1.6, 1.6);
    }
    ctx.globalAlpha = 1;
    ctx.strokeStyle = BOX;
    ctx.lineWidth = 1;
    ctx.strokeRect(bx, by, bw, bh);
  };
  raf = requestAnimationFrame(loop);
  onCleanup(() => cancelAnimationFrame(raf));
  return canvas;
}

export const card: DemoCard = {
  blurb:
    "120k wine reviews as an embedding map (Apple's Embedding Atlas view), cross-filtered with Mosaic against score, price, variety, and origin — lasso a cluster and every panel follows.",
  Preview,
};
