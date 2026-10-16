/**
 * Fourier.tsx — a square wave's harmonics as the pieces of one sum. Each
 * term's note is a miniature of its own wave (an SVG next to the math — an
 * annotation, not a style). Hover a term: its wave comes forward in the plot.
 * Click it: it is muted, struck through in the equation, dropped from the
 * sum. Move the slider: terms appear and vanish — the equation's structure
 * is reactive.
 */
import { ControlSlider } from "@habemus-papadum/aiui-viz";
import { PlotFigure } from "@habemus-papadum/aiui-viz/plot";
import { RichTeX, Term } from "@habemus-papadum/aiui-viz/site";
import type { JSX } from "@solidjs/web";
import { createSignal } from "solid-js";
import { harmonicK, harmonicTex, miniWavePath, rmsError } from "../../model/fourier";
import { graph } from "../../model/graph";
import { harmonics, muted, toggleMuted } from "../../model/store";
import { ramp } from "../hues";
import { fourierPlotOptions } from "../plots";

const MINI = { w: 64, h: 24 };

export function Fourier(): JSX.Element {
  const [hover, setHover] = createSignal<number | undefined>();
  const n = () => harmonics.get();
  const isMuted = (k: number) => muted.get().includes(k);
  const samples = () => graph().fourier.latest() ?? [];

  const MiniWave = (p: { k: number; color: string }) => (
    <svg
      class="rtx-lab-mini"
      width={MINI.w}
      height={MINI.h}
      viewBox={`0 0 ${MINI.w} ${MINI.h}`}
      aria-hidden="true"
    >
      <line x1="0" y1={MINI.h / 2} x2={MINI.w} y2={MINI.h / 2} class="rtx-lab-mini-axis" />
      <path d={miniWavePath(p.k, MINI.w, MINI.h)} stroke={p.color} fill="none" stroke-width="1.5" />
    </svg>
  );

  const indices = () => Array.from({ length: n() }, (_, i) => i + 1);

  return (
    <article class="lab-page">
      <header>
        <p class="eyebrow">fourier</p>
        <h1>Hover a term, see its wave</h1>
        <p class="lede">
          The square wave's series, one term per odd harmonic. Under each term, the wave it
          contributes. Hover a term to bring its wave forward; click it to mute it. The slider adds
          terms — the equation grows.
        </p>
      </header>

      <div class="lab-toolbar">
        <ControlSlider of={harmonics} label="harmonics" class="slider-compact" />
        <span class="small muted">
          rms error {rmsError(samples()).toFixed(3)}
          {muted.get().length > 0 ? ` · muted k = ${muted.get().join(", ")}` : ""}
        </span>
      </div>

      <RichTeX display class="rtx-lab-eq">
        {"f(x) \\approx \\frac{4}{\\pi}\\Big("}
        {indices().map((j) => {
          const k = harmonicK(j);
          return [
            j > 1 ? "+" : "",
            <Term
              id={`h${k}`}
              color={isMuted(k) ? undefined : ramp(j, n())}
              class={isMuted(k) ? "rtx-lab-muted" : undefined}
              active={hover() === k}
              onHover={(h) => setHover(h ? k : undefined)}
              onClick={() => toggleMuted(k)}
              note={<MiniWave k={k} color={isMuted(k) ? "currentColor" : ramp(j, n())} />}
            >
              {harmonicTex(k)}
            </Term>,
          ];
        })}
        {"+ \\cdots \\Big)"}
      </RichTeX>

      <div class="panel">
        <div class="panel-head">
          <h2>partial sum</h2>
          <span class="small muted">
            dashed: the square wave · heavy: the sum · thin: each harmonic
          </span>
        </div>
        <PlotFigure
          options={() => fourierPlotOptions(samples(), n(), hover(), new Set(muted.get()))}
        />
      </div>
    </article>
  );
}
