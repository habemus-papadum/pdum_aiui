/**
 * Wave.tsx — the canvas island: an rAF loop reading the controls untracked
 * (imperative capture layer; nothing here subscribes — the loop samples).
 */

import { onCleanup } from "solid-js";
import { amplitude, damping, freq, grid, kickState, waveform } from "../model/store";
import { type Waveform, waveValue } from "../model/wave";

export function Wave() {
  let canvas!: HTMLCanvasElement;
  let raf = 0;
  const t0 = performance.now();

  const draw = (now: number) => {
    raf = requestAnimationFrame(draw);
    const ctx = canvas.getContext("2d");
    if (ctx === null) {
      return;
    }
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    if (grid.get() === true) {
      ctx.strokeStyle = "#242933";
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let gx = 0; gx <= w; gx += w / 8) {
        ctx.moveTo(gx, 0);
        ctx.lineTo(gx, h);
      }
      ctx.moveTo(0, h / 2);
      ctx.lineTo(w, h / 2);
      ctx.stroke();
    }

    const t = (now - t0) / 1000;
    const f = freq.get() as number;
    // The kick: an amplitude ripple decaying at a damping-set rate.
    const sinceKick = (now - kickState.at) / 1000;
    const boost =
      kickState.at > 0 ? 0.5 * Math.exp(-sinceKick * (0.5 + 4 * (damping.get() as number))) : 0;
    const amp = ((amplitude.get() as number) + boost) * (h / 2) * 0.9;
    const kind = waveform.get() as Waveform;

    ctx.strokeStyle = "#7bb4e3";
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let x = 0; x <= w; x++) {
      const phase = 2 * Math.PI * (f * (x / w) - t * f * 0.5);
      const y = h / 2 - amp * waveValue(kind, phase);
      if (x === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();
  };

  raf = requestAnimationFrame(draw);
  onCleanup(() => cancelAnimationFrame(raf));

  return <canvas class="lab-wave" ref={canvas} />;
}
