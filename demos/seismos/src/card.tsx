/**
 * card.tsx — the landing-page card (see aiui-viz's DemoCard): a blurb and a
 * LIVE preview. Self-contained: it plots a synthetic Gutenberg–Richter
 * frequency–magnitude distribution with the demo's OWN pure math (`gr.ts`) —
 * no DuckDB, no Mosaic, no store/graph — sweeping the cumulative points in
 * under the fitted b-line.
 */
import type { DemoCard } from "@habemus-papadum/aiui-viz";
import { onCleanup } from "solid-js";
import { bValue, cumulative, fitLine, type MagBin } from "./gr";

const CW = 200;
const CH = 125;
const BG = "#0e1119";
const DOT = "#4a86dd";
const LINE = "#e0af68";
const AXIS = "#3a4152";

// A clean b≈1 catalog: incremental counts ~ 10^(A − M) with mild scatter.
function makeBins(): MagBin[] {
  const bins: MagBin[] = [];
  for (let m = 4.5; m < 7.95; m += 0.1) {
    const mag = Math.round(m * 10) / 10;
    const expected = 10 ** (7.6 - mag);
    bins.push({ mag, count: Math.max(0, Math.round(expected * (0.8 + Math.random() * 0.4))) });
  }
  return bins;
}

function Preview() {
  const canvas = document.createElement("canvas");
  canvas.width = CW;
  canvas.height = CH;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;

  const bins = makeBins();
  const cum = cumulative(bins).filter((p) => p.n > 0);
  const fit = bValue(bins, 4.6);
  const magMin = 4.5;
  const magMax = 7.9;
  const yMax = Math.log10(Math.max(...cum.map((p) => p.n)));
  const padL = 16;
  const padR = 10;
  const padT = 12;
  const padB = 14;
  const xOf = (m: number): number => padL + ((m - magMin) / (magMax - magMin)) * (CW - padL - padR);
  const yOf = (n: number): number => padT + (1 - Math.log10(n) / yMax) * (CH - padT - padB);

  const line = fit ? fitLine(fit, magMax) : null;

  let raf = 0;
  let reveal = 0; // 0..1 sweep, then hold, then restart
  const loop = (): void => {
    raf = requestAnimationFrame(loop);
    reveal += 0.012;
    const shown = Math.min(1, reveal);

    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, CW, CH);

    // axes
    ctx.strokeStyle = AXIS;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, padT);
    ctx.lineTo(padL, CH - padB);
    ctx.lineTo(CW - padR, CH - padB);
    ctx.stroke();

    // fitted b-line (drawn under the points)
    if (line) {
      ctx.strokeStyle = LINE;
      ctx.lineWidth = 1.5;
      ctx.globalAlpha = 0.9 * shown;
      ctx.beginPath();
      ctx.moveTo(xOf(line[0].mag), yOf(line[0].n));
      ctx.lineTo(xOf(line[1].mag), yOf(line[1].n));
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // cumulative points, revealed left→right
    ctx.fillStyle = DOT;
    const cutoff = magMin + shown * (magMax - magMin);
    for (const p of cum) {
      if (p.mag > cutoff) break;
      ctx.beginPath();
      ctx.arc(xOf(p.mag), yOf(p.n), 2, 0, Math.PI * 2);
      ctx.fill();
    }

    if (reveal > 1.9) reveal = 0; // pause on the full plot, then sweep again
  };
  raf = requestAnimationFrame(loop);
  onCleanup(() => cancelAnimationFrame(raf));
  return canvas;
}

export const card: DemoCard = {
  blurb:
    "A global earthquake catalog in DuckDB-WASM, cross-filtered with Mosaic. Brush the epicenter map or the time series and watch the Gutenberg–Richter b-value refit live.",
  Preview,
};
