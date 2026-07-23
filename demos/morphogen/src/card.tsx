/**
 * card.tsx — the landing-page card (see aiui-viz's DemoCard): a blurb and a
 * LIVE preview. This preview is self-contained on purpose — it runs a tiny CPU
 * Gray-Scott reaction–diffusion, NOT the demo's WebGL engine (the real page
 * runs this on the GPU) — so the gallery's landing page can mount it (and every
 * sibling's) without booting any heavy durable graph.
 */
import type { DemoCard } from "@habemus-papadum/aiui-viz";
import { onCleanup } from "solid-js";

const W = 132;
const H = 82;
const F = 0.037;
const K = 0.06;
const DU = 0.16;
const DV = 0.08;

function stepRD(u: Float32Array, v: Float32Array, u2: Float32Array, v2: Float32Array): void {
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const xm = (x - 1 + W) % W;
      const xp = (x + 1) % W;
      const ym = (y - 1 + H) % H;
      const yp = (y + 1) % H;
      const lu = u[ym * W + x] + u[yp * W + x] + u[y * W + xm] + u[y * W + xp] - 4 * u[i];
      const lv = v[ym * W + x] + v[yp * W + x] + v[y * W + xm] + v[y * W + xp] - 4 * v[i];
      const uvv = u[i] * v[i] * v[i];
      u2[i] = u[i] + (DU * lu - uvv + F * (1 - u[i]));
      v2[i] = v[i] + (DV * lv + uvv - (F + K) * v[i]);
    }
  }
}

function Preview() {
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;
  const img = ctx.createImageData(W, H);

  let u = new Float32Array(W * H).fill(1);
  let v = new Float32Array(W * H).fill(0);
  let u2 = new Float32Array(W * H);
  let v2 = new Float32Array(W * H);

  const seed = (): void => {
    u.fill(1);
    v.fill(0);
    for (let s = 0; s < 26; s++) {
      const cx = 5 + Math.floor(Math.random() * (W - 10));
      const cy = 5 + Math.floor(Math.random() * (H - 10));
      for (let dy = -3; dy <= 3; dy++) {
        for (let dx = -3; dx <= 3; dx++) {
          v[(cy + dy) * W + (cx + dx)] = 1;
        }
      }
    }
  };
  seed();

  let raf = 0;
  let last = 0;
  let frames = 0;
  const loop = (now: number): void => {
    raf = requestAnimationFrame(loop);
    if (now - last < 40) return; // ~24 fps — kind to the landing page
    last = now;
    for (let n = 0; n < 6; n++) {
      stepRD(u, v, u2, v2);
      [u, u2] = [u2, u];
      [v, v2] = [v2, v];
    }
    for (let i = 0; i < W * H; i++) {
      const c = Math.max(0, Math.min(1, v[i] * 3));
      const j = i * 4;
      img.data[j] = 20 + c * 40;
      img.data[j + 1] = 30 + c * 150;
      img.data[j + 2] = 45 + c * 130;
      img.data[j + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    // Re-seed occasionally so the pattern keeps evolving rather than settling.
    if (++frames > 520) {
      seed();
      frames = 0;
    }
  };
  raf = requestAnimationFrame(loop);
  onCleanup(() => cancelAnimationFrame(raf));
  return canvas;
}

export const card: DemoCard = {
  blurb:
    "Gray-Scott reaction–diffusion on the GPU, with a cancellable worker analysis pipeline and a live (F, k) regime atlas. Paint chemical onto the field and watch spots and stripes self-organize.",
  Preview,
};
