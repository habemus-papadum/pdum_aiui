/**
 * card.tsx — the landing-page card (see aiui-viz's DemoCard): a blurb and a
 * LIVE preview. Self-contained: it draws a wobbly hand circle, fits it with the
 * demo's OWN pure math (`fitCircle`), flashes the best-fit guide, then lets the
 * ink vanish — the gist of the pencil demo, with no PencilSurface, store, or
 * graph.
 */
import type { DemoCard } from "@habemus-papadum/aiui-viz";
import { onCleanup } from "solid-js";
import { fitCircle, type Vec } from "./model/circle";

const CW = 200;
const CH = 125;
const BG = "#0e1119";
const INK = "#ff6b6b";
const GUIDE = "#8ab4f8";
const N = 130;

function handCircle(): Vec[] {
  const cx = CW / 2 + (Math.random() - 0.5) * 8;
  const cy = CH / 2 + (Math.random() - 0.5) * 6;
  const r = 40 + Math.random() * 6;
  const p1 = Math.random() * Math.PI * 2;
  const p2 = Math.random() * Math.PI * 2;
  const drift = (Math.random() - 0.5) * 0.06;
  const pts: Vec[] = [];
  // Start a hair before 0 and end a hair after 2π, like a real un-closed stroke.
  for (let i = 0; i < N; i++) {
    const th = -0.12 + (i / (N - 1)) * (Math.PI * 2 + 0.24);
    const wob = 1 + 0.05 * Math.sin(3 * th + p1) + 0.03 * Math.sin(5 * th + p2) + drift * (th / 6);
    pts.push({ x: cx + r * wob * Math.cos(th), y: cy + r * wob * Math.sin(th) });
  }
  return pts;
}

function Preview() {
  const canvas = document.createElement("canvas");
  canvas.width = CW;
  canvas.height = CH;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;

  let pts = handCircle();
  let fit = fitCircle(pts);
  let phase = 0; // ms into the current cycle

  const DRAW = 1200;
  const HOLD = 700;
  const FADE = 600;
  const CYCLE = DRAW + HOLD + FADE;

  let raf = 0;
  let last = 0;
  const loop = (now: number): void => {
    raf = requestAnimationFrame(loop);
    const dt = last ? now - last : 16;
    last = now;
    phase += dt;
    if (phase > CYCLE) {
      phase = 0;
      pts = handCircle();
      fit = fitCircle(pts);
    }

    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, CW, CH);

    const drawn = Math.min(1, phase / DRAW);
    const alpha = phase < DRAW + HOLD ? 1 : 1 - (phase - DRAW - HOLD) / FADE;
    ctx.globalAlpha = Math.max(0, alpha);

    // the best-fit guide, flashed once the stroke is complete
    if (fit && phase > DRAW) {
      ctx.strokeStyle = GUIDE;
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.arc(fit.cx, fit.cy, fit.r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // the hand stroke, revealed point by point
    const upto = Math.max(2, Math.floor(drawn * pts.length));
    ctx.strokeStyle = INK;
    ctx.lineWidth = 2.6;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < upto; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke();
    ctx.globalAlpha = 1;
  };
  raf = requestAnimationFrame(loop);
  onCleanup(() => cancelAnimationFrame(raf));
  return canvas;
}

export const card: DemoCard = {
  blurb:
    "How round can you draw a circle? A vanishing-ink pencil surface scores each stroke with a live least-squares fit — draw one and watch the ellipse, centre, and score appear.",
  Preview,
};
