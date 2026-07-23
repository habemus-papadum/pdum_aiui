/**
 * card.tsx — the landing card: a live miniature of the two-source lab, drawn
 * with the engine's own math (sourceAt from aiui-optics — pure model only, no
 * store/graph). Two emitters, their traveling interference pattern; the
 * complex field is precomputed once so each frame is a cheap cosine pass.
 */
import { type Rgb, sourceAt, waveColor } from "@habemus-papadum/aiui-optics";
import type { DemoCard } from "@habemus-papadum/aiui-viz";
import { onCleanup } from "solid-js";

const W = 168;
const H = 112;
const LAMBDA = 9;
const SEP = 34;

function Preview() {
  let raf = 0;

  // static complex field, computed once — animation is a phase rotation
  const re = new Float32Array(W * H);
  const im = new Float32Array(W * H);
  const tint: Rgb = waveColor(LAMBDA, [4.5, 13.5]);
  const neg: Rgb = [
    0.1 + 0.5 * (1 - tint[0]),
    0.1 + 0.5 * (1 - tint[1]),
    0.1 + 0.5 * (1 - tint[2]),
  ];
  const sources = [
    { kind: "point", x: -SEP / 2, z: 0, amp: 1 },
    { kind: "point", x: SEP / 2, z: 0, amp: 1 },
  ] as const;
  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      // world: z to the right, x up; sources near the left edge
      const z = (px / W) * 220 - 18;
      const x = (0.5 - py / H) * 150;
      let sr = 0;
      let si = 0;
      for (const s of sources) {
        const e = sourceAt(s, x, z, LAMBDA);
        sr += e.re;
        si += e.im;
      }
      re[py * W + px] = sr;
      im[py * W + px] = si;
    }
  }

  const mount = (el: HTMLCanvasElement): void => {
    const ctx = el.getContext("2d");
    if (!ctx) return;
    const img = ctx.createImageData(W, H);
    let t0 = 0;
    const loop = (t: number): void => {
      raf = requestAnimationFrame(loop);
      if (!t0) t0 = t;
      const ph = ((t - t0) / 1000) * 2 * Math.PI * 0.5;
      const c = Math.cos(ph);
      const s = Math.sin(ph);
      for (let i = 0; i < re.length; i++) {
        let a = (re[i] * c + im[i] * s) * 0.75;
        a = a / (1 + 0.35 * Math.abs(a));
        const pos = Math.max(a, 0);
        const ng = Math.max(-a, 0);
        const o = i * 4;
        img.data[o] = Math.min(255, 255 * (pos * tint[0] + ng * neg[0]));
        img.data[o + 1] = Math.min(255, 255 * (pos * tint[1] + ng * neg[1]));
        img.data[o + 2] = Math.min(255, 255 * (pos * tint[2] + ng * neg[2]));
        img.data[o + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
    };
    raf = requestAnimationFrame(loop);
  };
  onCleanup(() => cancelAnimationFrame(raf));

  return (
    <canvas
      ref={mount}
      width={W}
      height={H}
      role="img"
      aria-label="two interfering wave sources"
      style={{ width: "100%", height: "100%", display: "block" }}
    />
  );
}

export const card: DemoCard = {
  blurb:
    "Diffraction as a design tool: phase arrows, the grating equation, a spectrometer designer, and a lens built out of stripes — every picture computed from the wave equation, live.",
  Preview,
};
