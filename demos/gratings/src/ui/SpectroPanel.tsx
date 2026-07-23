/**
 * SpectroPanel.tsx — the first engineering payoff: the same mask, fed six
 * wavelengths at once. The map is time-averaged intensity (white light has no
 * single clock to animate); the chart shows each λ's orders landing at their
 * own angles, plus the two numbers a spectrometer designer actually works
 * with — resolving power and order overlap.
 */
import { FieldMap } from "@habemus-papadum/aiui-optics/widgets";
import { CellView, ControlSlider } from "@habemus-papadum/aiui-viz";
import { Show } from "solid-js";
import { graph } from "../model/graph";
import { nSlits, pitch } from "../model/store";
import { AngleChart } from "./AngleChart";
import { MaskBars } from "./overlays";

export function SpectroPanel() {
  return (
    <div class="bench">
      <div class="bench-stage">
        <CellView of={graph().spectroMap} label="spectrometer map">
          {(v) => (
            <div class="map-wrap">
              <FieldMap
                data={v()}
                aspect={760 / 660}
                gain={0.4}
                overlay={<MaskBars pitch={pitch.get()} count={nSlits.get()} xHalf={330} />}
              />
            </div>
          )}
        </CellView>
        <p class="map-caption">
          six wavelengths, one grating: each color's m = ±1 kick is proportional to its λ, so the
          fan is a spectrum (time-averaged view — white light has no single phase to animate)
        </p>
      </div>

      <div class="bench-side">
        <div class="controls">
          <ControlSlider of={pitch} label="pitch Λ" format={(v) => `${v} µm`} />
          <ControlSlider of={nSlits} label="slits N" format={(v) => `${v}`} />
        </div>
        <CellView of={graph().spectroChart} label="spectrometer numbers">
          {(v) => (
            <div class="readouts">
              <div>
                <span class="rd-num">
                  {v().fan.from.toFixed(1)}°–{v().fan.to.toFixed(1)}°
                </span>
                <span class="rd-lbl">first-order fan (violet→red)</span>
              </div>
              <div>
                <span class="rd-num">{v().resolve}</span>
                <span class="rd-lbl">resolving power R = m·N</span>
              </div>
              <div>
                <span class="rd-num">{v().dLambdaMid.toFixed(2)} µm</span>
                <span class="rd-lbl">smallest Δλ split at mid-band</span>
              </div>
              <Show when={v().overlap}>
                <div class="warn">
                  <span class="rd-num">⚠ {v().overlapDeg.toFixed(1)}°</span>
                  <span class="rd-lbl">
                    m=2 violet lands inside the m=1 fan — a real spectrometer adds an order-sorting
                    filter here
                  </span>
                </div>
              </Show>
            </div>
          )}
        </CellView>
      </div>

      <div class="bench-chart">
        <CellView of={graph().spectroChart} label="per-λ far fields">
          {(v) => (
            <AngleChart
              series={v().series.map((s) => ({ ...s, color: cssColor(s.color) }))}
              sinMax={0.85}
            />
          )}
        </CellView>
        <p class="map-caption">
          each λ's exit directions — the m=1 needles spread into a spectrum; needle width is what R
          = m·N buys
        </p>
      </div>
    </div>
  );
}

const cssColor = (c: [number, number, number]): string =>
  `rgb(${Math.round(c[0] * 255)}, ${Math.round(c[1] * 255)}, ${Math.round(c[2] * 255)})`;
