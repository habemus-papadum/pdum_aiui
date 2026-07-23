/**
 * card.tsx — the landing-page card (see aiui-viz's DemoCard): a blurb and a
 * LIVE preview. Self-contained: it grows one Aztec-diamond tiling with the
 * demo's OWN pure shuffle math (no worker, no store/graph), redrawing the
 * four-colour dominoes each step so the arctic circle forms on the card.
 */
import type { DemoCard } from "@habemus-papadum/aiui-viz";
import { onCleanup } from "solid-js";
import { COLOR } from "./palette";
import { mulberry32 } from "./rng";
import { initTiling, rasterize, step } from "./shuffle";

const CW = 200;
const CH = 125;
const TARGET_N = 14;
const BG = "#0e1119";

function Preview() {
  const canvas = document.createElement("canvas");
  canvas.width = CW;
  canvas.height = CH;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;

  let seed = (Math.random() * 0xffffffff) >>> 0;
  let rng = mulberry32(seed);
  let t = initTiling(rng);
  let hold = 0;

  const draw = (): void => {
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, CW, CH);
    const grid = rasterize(t);
    const size = 2 * t.n;
    const cell = Math.floor(Math.min(CW, CH) / size);
    if (cell < 1) return;
    const off = (CW - size * cell) / 2;
    const offY = (CH - size * cell) / 2;
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        const val = grid[r * size + c];
        if (!val) continue;
        ctx.fillStyle = COLOR[val as 1 | 2 | 3 | 4];
        ctx.fillRect(off + c * cell, offY + r * cell, cell, cell);
      }
    }
  };

  let raf = 0;
  let last = 0;
  const loop = (now: number): void => {
    raf = requestAnimationFrame(loop);
    if (now - last < 150) return; // one growth step every ~150ms
    last = now;
    if (t.n < TARGET_N) {
      t = step(t, rng);
    } else if (++hold > 8) {
      // Finished: pause on the arctic circle, then regrow a fresh random one.
      seed = (seed * 1664525 + 1013904223) >>> 0;
      rng = mulberry32(seed);
      t = initTiling(rng);
      hold = 0;
    }
    draw();
  };
  draw();
  raf = requestAnimationFrame(loop);
  onCleanup(() => cancelAnimationFrame(raf));
  return canvas;
}

export const card: DemoCard = {
  blurb:
    "Uniformly-random domino tilings of the Aztec diamond, grown by EKLP shuffling. Watch the arctic circle emerge — four frozen corners of brickwork around a disordered disc.",
  Preview,
};
