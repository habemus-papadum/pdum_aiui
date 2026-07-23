/**
 * FilmPanel.tsx — the film itself, three ways: the exposure it integrated
 * (fringes), the grains that remember it (the physical memory), and the
 * developed transmission t(x) it becomes (an optical element). Plus the
 * darkroom knobs and the two design readouts that gate everything: fringe
 * pitch vs emulsion resolution, and where the played-back power goes.
 */
import { FilmStrip, GrainStrip } from "@habemus-papadum/aiui-optics/widgets";
import { CellView, ControlSlider, ControlToggle } from "@habemus-papadum/aiui-viz";
import { Show } from "solid-js";
import { FILM } from "../model/bench";
import { graph } from "../model/graph";
import { bleach, filmRes, gamma, objGain } from "../model/store";

export function FilmPanel() {
  return (
    <div class="bench">
      <div class="bench-stage">
        <div class="strip-stack">
          <div>
            <CellView of={graph().exposure} label="exposure">
              {(v) => (
                <FilmStrip
                  data={v().exposure}
                  x0={v().x0}
                  dx={v().dx}
                  color={v().tint}
                  normalize="mean"
                  height={38}
                />
              )}
            </CellView>
            <p class="map-caption">1 · the exposure: intensity, integrated — all the film saw</p>
          </div>
          <div>
            <CellView of={graph().grains} label="grains">
              {(v) => <GrainStrip dots={v()} x0={FILM.x0} x1={-FILM.x0} height={38} />}
            </CellView>
            <p class="map-caption">
              2 · the memory: silver-halide grains blackened where the fringes were bright — a
              census of photons, not a picture of anything
            </p>
          </div>
          <div>
            <CellView of={graph().developed} label="developed film">
              {(v) => (
                <FilmStrip
                  data={v().profile}
                  x0={FILM.x0}
                  dx={FILM.dx}
                  color={v().bleached ? [0.72, 0.82, 0.95] : [0.93, 0.87, 0.72]}
                  height={38}
                />
              )}
            </CellView>
            <p class="map-caption">
              3 · the developed film t(x): the memory become an optical element —{" "}
              <Show when={bleach.get()} fallback={<>darkened silver (absorption stripes)</>}>
                bleached relief (phase stripes — shown as delay)
              </Show>
            </p>
          </div>
        </div>
      </div>

      <div class="bench-side">
        <div class="controls">
          <ControlSlider of={gamma} label="development γ" format={(v) => `${v.toFixed(2)}`} />
          <ControlToggle of={bleach} label="bleach (phase film)" />
          <ControlSlider of={filmRes} label="emulsion resolution" format={(v) => `${v} µm`} />
          <ControlSlider
            of={objGain}
            label="object brightness"
            format={(v) => `${v.toFixed(1)}×`}
          />
        </div>
        <CellView of={graph().benchNumbers} label="film numbers">
          {(v) => (
            <div class="readouts">
              <div>
                <span class="rd-num">{v().finest.toFixed(0)} µm</span>
                <span class="rd-lbl">finest fringe recorded</span>
              </div>
              <div class={v().filmOk ? "" : "warn"}>
                <span class="rd-num">{v().filmOk ? "✓ holds" : "⚠ lost"}</span>
                <span class="rd-lbl">
                  emulsion at {filmRes.get()} µm vs those fringes — coarse film erases the
                  steep-angle parts first
                </span>
              </div>
            </div>
          )}
        </CellView>
        <CellView of={graph().split} label="beam split">
          {(v) => (
            <div class="readouts">
              <div>
                <span class="rd-num">{(v().image * 100).toFixed(1)}%</span>
                <span class="rd-lbl">of played-back light reaches the image</span>
              </div>
              <div>
                <span class="rd-num">{(v().zero * 100).toFixed(0)}%</span>
                <span class="rd-lbl">passes straight through</span>
              </div>
            </div>
          )}
        </CellView>
      </div>
    </div>
  );
}
