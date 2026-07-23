/**
 * Window2D.tsx — the finale's two panes: the 2-D film (HoloFilmView, drag to
 * move your pupil) and what the eye sees through that patch (the windowView
 * cell — honest 2-D Fourier optics, upscaled onto a canvas). Everything the
 * page taught, at full dimension: parallax by dragging, accommodation on the
 * focus slider, cut-the-film on the aperture slider.
 */
import { waveColor } from "@habemus-papadum/aiui-optics";
import { CellView, ControlSlider } from "@habemus-papadum/aiui-viz";
import { createEffect, onCleanup } from "solid-js";
import { graph } from "../model/graph";
import { winAperture, winFocus, winZoom } from "../model/store";
import { WINDOW_LAMBDA, type WindowView } from "../model/window2d";
import { HoloFilmView } from "./HoloFilmView";

/** The retina canvas: draw the m×m view, tonemapped and tinted, upscaled. */
function ViewCanvas(props: { view: WindowView }) {
  let canvas!: HTMLCanvasElement;
  let ro: ResizeObserver | undefined;
  onCleanup(() => ro?.disconnect());

  const tint = waveColor(WINDOW_LAMBDA, [4.5, 13.5]);

  const draw = (v: WindowView): void => {
    const ctx = canvas.getContext("2d");
    if (!ctx || !v) return;
    const m = v.m;
    const off = new OffscreenCanvas(m, m);
    const octx = off.getContext("2d");
    if (!octx) return;
    const img = octx.createImageData(m, m);
    // normalize to a high percentile so one bright spot doesn't crush the rest
    const sorted = Float32Array.from(v.img).sort();
    const norm = sorted[Math.floor(sorted.length * 0.998)] || 1;
    for (let i = 0; i < m * m; i++) {
      const b = 1 - Math.exp((-2.2 * v.img[i]) / norm);
      img.data[i * 4] = Math.min(255, 255 * b * tint[0]);
      img.data[i * 4 + 1] = Math.min(255, 255 * b * tint[1]);
      img.data[i * 4 + 2] = Math.min(255, 255 * b * tint[2]);
      img.data[i * 4 + 3] = 255;
    }
    octx.putImageData(img, 0, 0);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const holder = canvas.parentElement as HTMLElement;
    const size = Math.max(1, Math.round(holder.clientWidth * dpr));
    canvas.width = size;
    canvas.height = size;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(off, 0, 0, size, size);
  };

  const setup = (el: HTMLCanvasElement): void => {
    canvas = el;
    ro = new ResizeObserver(() => draw(props.view));
    if (el.parentElement) ro.observe(el.parentElement);
  };

  createEffect(
    () => props.view,
    (v) => draw(v),
  );

  return (
    <div class="view2d-wrap">
      <canvas ref={setup} class="view2d-canvas" />
    </div>
  );
}

export function Window2D() {
  return (
    <div class="bench">
      <div class="bench-stage">
        <HoloFilmView />
        <p class="map-caption">
          the film itself — drag to slide your pupil (the bracket); zoom in until the actual fringes
          appear. At middle zooms the shimmer is moiré: the fringes outresolve your screen, which is
          rather the point. There is no picture here.
        </p>
        <div class="controls" style={{ "margin-top": "8px" }}>
          <ControlSlider of={winZoom} label="film zoom" format={(v) => `${v.toFixed(1)}×`} />
        </div>
      </div>

      <div class="bench-side">
        <CellView of={graph().windowView} label="through the window">
          {(v) => <ViewCanvas view={v()} />}
        </CellView>
        <p class="map-caption">
          …and the view through the bracket: a glowing cube, floating behind a film that stores only
          mottle. Drag the film to walk your head — the cube's near face slides against its far
          face. Real parallax, from a flat plate.
        </p>
        <div class="controls">
          <ControlSlider of={winFocus} label="focus depth" format={(v) => `${v} µm`} />
          <ControlSlider
            of={winAperture}
            label="pupil (piece of film used)"
            format={(v) => `${v} µm`}
          />
        </div>
      </div>
    </div>
  );
}
