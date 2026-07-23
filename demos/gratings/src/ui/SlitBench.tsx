/**
 * SlitBench.tsx — the star apparatus: a plane wave meets an N-slit mask, and
 * the exit side becomes a fan of beams. The dashed rays ARE the grating
 * equation (sinθ = sinθin + mλ/Λ) drawn over the computed wave — the page's
 * central move: the cheap design rule and the honest wave agree, live.
 *
 * Pure reader: map + numbers from the graph, controls from the store. The
 * far-field chart and slit-arrow dial mount optionally so the overview and
 * the "from two to many" section can show different faces of one bench.
 */

import { FieldMap, PhasorDial } from "@habemus-papadum/aiui-optics/widgets";
import { CellView, ControlSlider, ControlToggle } from "@habemus-papadum/aiui-viz";
import { Show } from "solid-js";
import { graph } from "../model/graph";
import { incidentDeg, lambda, nSlits, pitch, probeX, probeZ, showWave } from "../model/store";
import { AngleChart } from "./AngleChart";
import { css, MapDot, MaskBars, Ray } from "./overlays";

function BenchReadouts() {
  return (
    <CellView of={graph().benchNumbers} label="bench numbers">
      {(v) => (
        <div class="readouts">
          <div>
            <span class="rd-num">{v().kick.toFixed(3)}</span>
            <span class="rd-lbl">kick λ/Λ (sinθ per order)</span>
          </div>
          <div>
            <span class="rd-num">
              {v()
                .orders.filter((o) => o.m === 1)
                .map((o) => `${o.deg.toFixed(1)}°`)[0] ?? "—"}
            </span>
            <span class="rd-lbl">first-order angle</span>
          </div>
          <div>
            <span class="rd-num">{v().orders.length}</span>
            <span class="rd-lbl">orders that clear the mask</span>
          </div>
          <div>
            <span class="rd-num">{v().resolve}</span>
            <span class="rd-lbl">resolving power m·N</span>
          </div>
        </div>
      )}
    </CellView>
  );
}

export function SlitBench(props: { chart?: boolean; dial?: boolean }) {
  const ordersLatest = () => graph().benchNumbers() ?? { orders: [], resolve: 0, kick: 0 };
  return (
    <div class="bench">
      <div class="bench-stage">
        <CellView of={graph().slitBench} label="wave map">
          {(v) => (
            <div class="map-wrap">
              <FieldMap
                data={v()}
                view={showWave.get() ? "wave" : "intensity"}
                aspect={760 / 660}
                overlay={
                  <g data-cell="gratings/benchNumbers">
                    <MaskBars pitch={pitch.get()} count={nSlits.get()} xHalf={330} />
                    {ordersLatest().orders.map((o) => (
                      <Ray
                        sin={o.sin}
                        color={
                          o.m === 0
                            ? "rgba(150, 158, 172, 0.65)"
                            : `rgba(230, 210, 74, ${Math.abs(o.m) === 1 ? 0.8 : 0.45})`
                        }
                      />
                    ))}
                  </g>
                }
              />
              <Show when={props.dial}>
                <MapDot extent={v()} z={probeZ.get()} x={probeX.get()} kind="probe" />
              </Show>
            </div>
          )}
        </CellView>
        <p class="map-caption">
          light enters from the left; the mask sits on the dashed column of bars; dashed rays = the
          grating equation's predicted orders
        </p>
      </div>

      <div class="bench-side">
        <div class="controls">
          <ControlSlider of={lambda} label="wavelength λ" format={(v) => `${v.toFixed(1)} µm`} />
          <ControlSlider of={pitch} label="pitch Λ" format={(v) => `${v} µm`} />
          <ControlSlider of={nSlits} label="slits N" format={(v) => `${v}`} />
          <ControlSlider
            of={incidentDeg}
            label="incident angle"
            format={(v) => `${v.toFixed(1)}°`}
          />
          <ControlToggle of={showWave} label="traveling wave (off = what film sees)" />
        </div>
        <BenchReadouts />
        <Show when={props.dial}>
          <CellView of={graph().slitArrows} label="slit arrows">
            {(v) => (
              <div class="dial-box" data-cell="gratings/slitArrows">
                <PhasorDial
                  arrows={v().arrows}
                  resultantColor={css(v().tint)}
                  title="one arrow per slit, at the probe"
                />
                <p class="dial-caption">
                  one arrow per slit, for the direction the probe marks (far-field phases — neighbor
                  step k·Λ·sinθ). Park the probe on a yellow ray and the arrows lock; nudge it off
                  and they coil closed. Set <code>probeX</code>/<code>probeZ</code> or drag on the
                  two-source map above.
                </p>
              </div>
            )}
          </CellView>
        </Show>
      </div>

      <Show when={props.chart}>
        <div class="bench-chart">
          <CellView of={graph().slitFar} label="far field">
            {(v) => (
              <AngleChart
                series={[{ sin: v().sin, power: v().power, color: css(v().color) }]}
                marks={v().orders.map((o) => ({ sin: o.sin, label: `m=${o.m}` }))}
              />
            )}
          </CellView>
          <p class="map-caption">
            exit power vs direction (γ-stretched); dashed marks are the grating equation
          </p>
        </div>
      </Show>
    </div>
  );
}
