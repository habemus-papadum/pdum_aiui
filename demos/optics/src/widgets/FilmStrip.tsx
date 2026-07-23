/**
 * FilmStrip.tsx — a 1-D profile drawn the way film holds it: a horizontal
 * strip whose brightness at x is the value at x. Used for exposures ("what
 * the film saw"), developed transmissions ("what the film became"), and
 * detector lines. An optional window marks the kept region of a cut film —
 * the outside dims, scissor lines mark the cuts.
 *
 * A plain 2-D canvas island: redraws on data/window change and on resize.
 */
import { createEffect, onCleanup, untrack } from "solid-js";
import type { Rgb } from "../color";

export function FilmStrip(props: {
  /** Values ≥ 0 on a uniform grid. */
  data: Float64Array | Float32Array;
  x0: number;
  dx: number;
  /** Tint color. Default a warm film gray. */
  color?: Rgb;
  /** Strip height in px. Default 44. */
  height?: number;
  /** Normalize brightness by: "max" (default), "mean" (2× mean = full), or a number. */
  normalize?: "max" | "mean" | number;
  /** Kept region of a cut film; outside dims to 20%. */
  window?: { center: number; width: number } | null;
  class?: string;
}) {
  let canvas!: HTMLCanvasElement;
  let ro: ResizeObserver | undefined;
  onCleanup(() => ro?.disconnect());

  // Snapshot ALL props once per draw: the pixel loop must never touch a
  // reactive getter (each read walks the CellView accessor chain — thousands
  // of untracked reads per frame was both a dev-warning storm and a real cost).
  const snap = () => ({
    data: props.data,
    x0: props.x0,
    dx: props.dx,
    color: props.color,
    height: props.height,
    normalize: props.normalize,
    window: props.window,
  });
  type Snap = ReturnType<typeof snap>;

  const draw = (s: Snap): void => {
    const c2d = canvas.getContext("2d");
    if (!c2d || !s.data) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const wCss = canvas.parentElement?.clientWidth ?? 300;
    const hCss = s.height ?? 44;
    const w = Math.max(1, Math.round(wCss * dpr));
    const h = Math.max(1, Math.round(hCss * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      canvas.style.height = `${hCss}px`;
    }

    const data = s.data;
    const n = data.length;
    let norm: number;
    if (typeof s.normalize === "number") norm = s.normalize;
    else if (s.normalize === "mean") {
      let acc = 0;
      for (let i = 0; i < n; i++) acc += data[i];
      norm = (2 * acc) / n || 1;
    } else {
      norm = 0;
      for (let i = 0; i < n; i++) if (data[i] > norm) norm = data[i];
      norm = norm || 1;
    }

    const [tr, tg, tb] = s.color ?? [0.93, 0.87, 0.72];
    const img = c2d.createImageData(w, h);
    const win = s.window;
    const x1 = s.x0 + n * s.dx;
    const lo = win ? win.center - win.width / 2 : Number.NEGATIVE_INFINITY;
    const hi = win ? win.center + win.width / 2 : Number.POSITIVE_INFINITY;
    for (let px = 0; px < w; px++) {
      const x = s.x0 + ((px + 0.5) / w) * (x1 - s.x0);
      const fi = (x - s.x0) / s.dx - 0.5;
      const i0 = Math.max(0, Math.min(n - 1, Math.floor(fi)));
      const i1 = Math.min(n - 1, i0 + 1);
      const frac = Math.min(1, Math.max(0, fi - i0));
      const v = data[i0] * (1 - frac) + data[i1] * frac;
      let b = Math.sqrt(Math.min(1.6, Math.max(0, v / norm))); // gentle gamma
      if (x < lo || x > hi) b *= 0.18;
      const r = Math.round(255 * Math.min(1, b * tr));
      const g = Math.round(255 * Math.min(1, b * tg));
      const bl = Math.round(255 * Math.min(1, b * tb));
      for (let py = 0; py < h; py++) {
        const o = (py * w + px) * 4;
        img.data[o] = r;
        img.data[o + 1] = g;
        img.data[o + 2] = bl;
        img.data[o + 3] = 255;
      }
    }
    c2d.putImageData(img, 0, 0);

    // scissor marks at the cut edges
    if (win) {
      c2d.strokeStyle = "rgba(240, 120, 90, 0.9)";
      c2d.lineWidth = Math.max(1, dpr);
      c2d.setLineDash([5 * dpr, 4 * dpr]);
      for (const edge of [lo, hi]) {
        if (edge <= s.x0 || edge >= x1) continue;
        const px = ((edge - s.x0) / (x1 - s.x0)) * w;
        c2d.beginPath();
        c2d.moveTo(px, 0);
        c2d.lineTo(px, h);
        c2d.stroke();
      }
      c2d.setLineDash([]);
    }
  };

  const setup = (el: HTMLCanvasElement): void => {
    canvas = el;
    ro = new ResizeObserver(() => draw(untrack(snap)));
    if (el.parentElement) ro.observe(el.parentElement);
  };

  createEffect(snap, (s) => draw(s));

  return (
    <div class={props.class ? `optix-strip ${props.class}` : "optix-strip"}>
      <canvas ref={setup} class="optix-strip-canvas" />
    </div>
  );
}

/**
 * GrainStrip — the same strip, but as the emulsion sees it: individual
 * blackened grains, denser where the exposure was brighter. Pass the dots
 * from film.ts's `grainDots` (deterministic, seeded).
 */
export function GrainStrip(props: {
  /** Interleaved (x, y01) pairs. */
  dots: Float32Array;
  x0: number;
  x1: number;
  height?: number;
  class?: string;
}) {
  let canvas!: HTMLCanvasElement;
  let ro: ResizeObserver | undefined;
  onCleanup(() => ro?.disconnect());

  // same snapshot-per-draw discipline as FilmStrip: no reactive reads in loops
  const snap = () => ({ dots: props.dots, x0: props.x0, x1: props.x1, height: props.height });
  type Snap = ReturnType<typeof snap>;

  const draw = (s: Snap): void => {
    const c2d = canvas.getContext("2d");
    if (!c2d || !s.dots) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const wCss = canvas.parentElement?.clientWidth ?? 300;
    const hCss = s.height ?? 44;
    const w = Math.max(1, Math.round(wCss * dpr));
    const h = Math.max(1, Math.round(hCss * dpr));
    canvas.width = w;
    canvas.height = h;
    canvas.style.height = `${hCss}px`;
    // unexposed emulsion: a pale plate; grains darken it
    c2d.fillStyle = "#cfc8b4";
    c2d.fillRect(0, 0, w, h);
    c2d.fillStyle = "rgba(28, 24, 18, 0.85)";
    const dots = s.dots;
    const span = s.x1 - s.x0 || 1;
    const r = Math.max(1, 0.8 * dpr);
    for (let i = 0; i < dots.length; i += 2) {
      const px = ((dots[i] - s.x0) / span) * w;
      const py = dots[i + 1] * h;
      c2d.fillRect(px - r / 2, py - r / 2, r, r);
    }
  };

  const setup = (el: HTMLCanvasElement): void => {
    canvas = el;
    ro = new ResizeObserver(() => draw(untrack(snap)));
    if (el.parentElement) ro.observe(el.parentElement);
  };

  createEffect(snap, (s) => draw(s));

  return (
    <div class={props.class ? `optix-strip ${props.class}` : "optix-strip"}>
      <canvas ref={setup} class="optix-strip-canvas" />
    </div>
  );
}
