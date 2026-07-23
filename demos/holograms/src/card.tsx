/**
 * card.tsx — the landing card: a hologram being recorded, in miniature. A
 * tilted reference plane wave crosses the glow of a point object; their
 * standing fringes — the pattern a film there would memorize — hold still
 * while the phase races through. Pure engine math only (no store/graph).
 */
import { type Rgb, sourceAt, waveColor } from "@habemus-papadum/aiui-optics";
import type { DemoCard } from "@habemus-papadum/aiui-viz";
import { onCleanup } from "solid-js";

const W = 168;
const H = 112;
const LAMBDA = 9;

function Preview() {
  let raf = 0;

  const re = new Float32Array(W * H);
  const im = new Float32Array(W * H);
  const tint: Rgb = waveColor(LAMBDA, [4.5, 13.5]);
  const neg: Rgb = [
    0.1 + 0.5 * (1 - tint[0]),
    0.1 + 0.5 * (1 - tint[1]),
    0.1 + 0.5 * (1 - tint[2]),
  ];
  const sources = [
    { kind: "plane", angleDeg: -16, amp: 0.8 },
    { kind: "point", x: -18, z: -40, amp: 1.6 },
  ] as const;
  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      const z = (px / W) * 230 - 30;
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
        let a = (re[i] * c + im[i] * s) * 0.7;
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
      aria-label="a reference beam interfering with a point object — a hologram being recorded"
      style={{ width: "100%", height: "100%", display: "block" }}
    />
  );
}

export const card: DemoCard = {
  blurb:
    "Record interference on a virtual bench, develop the film, and shine the reference back through: the object's wavefront returns — with parallax, cut-the-film, playback remixes, and every failure mode a real bench has.",
  Preview,
};
