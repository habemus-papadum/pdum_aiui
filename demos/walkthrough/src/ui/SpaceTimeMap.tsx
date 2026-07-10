/**
 * SpaceTimeMap.tsx — the whole run as a space–time heatmap (x across, t down),
 * drawn into a canvas. The canvas is an imperative island: Solid never touches
 * its pixels — a `createEffect(source, handler)` bridge reads the evolution in
 * the SOURCE (tracked) and paints in the HANDLER (untracked), the one correct
 * shape for reactive→imperative hand-off (reading signals in the handler is
 * the STRICT_READ_UNTRACKED trap the hard-won ledger records).
 */
import { createEffect } from "solid-js";
import type { Evolution } from "../model/diffusion.worker";

/** Inferno-ish ramp, u ∈ [0,1] → rgb. Good enough for a teaching heatmap. */
function heat(u: number): [number, number, number] {
  const v = Math.min(1, Math.max(0, u));
  return [Math.round(255 * Math.min(1, 2.5 * v)), Math.round(255 * v ** 1.5), Math.round(60 * v)];
}

export function SpaceTimeMap(props: { evolution: Evolution }) {
  let canvas: HTMLCanvasElement | undefined;

  const draw = (e: Evolution) => {
    if (!canvas || e.frames.length === 0) return;
    const n = e.frames[0].u.length;
    canvas.width = n;
    canvas.height = e.frames.length;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const img = ctx.createImageData(n, e.frames.length);
    for (let row = 0; row < e.frames.length; row++) {
      const u = e.frames[row].u;
      for (let i = 0; i < n; i++) {
        const [r, g, b] = heat(u[i]);
        const o = (row * n + i) * 4;
        img.data[o] = r;
        img.data[o + 1] = g;
        img.data[o + 2] = b;
        img.data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  };

  // Reactive → imperative bridge: track in the source, paint in the handler.
  createEffect(
    () => props.evolution,
    (e) => {
      draw(e);
    },
  );

  return (
    <figure class="spacetime">
      <canvas ref={canvas} aria-label="space-time heatmap: x across, time downward" />
      <figcaption class="muted">u(x, t): x across, time downward, brightness = heat</figcaption>
    </figure>
  );
}
