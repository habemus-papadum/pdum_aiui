/**
 * SculptPanel.tsx — the bridge idea: the deflection rule is LOCAL, so a
 * grating whose pitch varies steers different strips differently. Zones cut
 * so every strip aims at one point = a lens made of stripes. The λ knob shows
 * its chromatic soul: f ∝ 1/λ.
 */
import { FieldMap } from "@habemus-papadum/aiui-optics/widgets";
import { CellView, ControlSlider, ControlToggle } from "@habemus-papadum/aiui-viz";
import { zoneLocalPitch } from "../model/bench";
import { graph } from "../model/graph";
import { incidentDeg, lambda, showWave, zoneF } from "../model/store";
import { MapDot, PlaneLine, Ray } from "./overlays";

export function SculptPanel() {
  const sinIn = () => Math.sin((incidentDeg.get() * Math.PI) / 180);
  // the focus of a tilted plane wave walks off-axis: x ≈ f·tanθ
  const focusX = () => zoneF.get() * (sinIn() / Math.sqrt(1 - sinIn() ** 2));
  return (
    <div class="bench">
      <div class="bench-stage">
        <CellView of={graph().sculptMap} label="stripe-lens map">
          {(v) => (
            <div class="map-wrap">
              <FieldMap
                data={v()}
                view={showWave.get() ? "wave" : "intensity"}
                aspect={760 / 660}
                overlay={
                  <g>
                    <PlaneLine z={0} xHalf={240} color="rgba(190, 160, 110, 0.8)" dash="2 3" />
                    {/* edge rays aimed at the design focus */}
                    <Ray
                      from={{ z: 0, x: 240 }}
                      sin={-240 / Math.hypot(240, zoneF.get())}
                      color="rgba(230, 210, 74, 0.6)"
                    />
                    <Ray
                      from={{ z: 0, x: -240 }}
                      sin={240 / Math.hypot(240, zoneF.get())}
                      color="rgba(230, 210, 74, 0.6)"
                    />
                  </g>
                }
              />
              <MapDot
                extent={v()}
                z={zoneF.get()}
                x={focusX()}
                kind="ghost"
                label="predicted focus"
              />
            </div>
          )}
        </CellView>
        <p class="map-caption">
          a plane wave meets the zone plate (dashed plate at z = 0, aperture ±240 µm); the guide
          rays leave its edges at their local grating angle — they cross at f
        </p>
      </div>

      <div class="bench-side">
        <div class="controls">
          <ControlSlider of={zoneF} label="designed focus f" format={(v) => `${v} µm`} />
          <ControlSlider of={lambda} label="wavelength λ" format={(v) => `${v.toFixed(1)} µm`} />
          <ControlSlider
            of={incidentDeg}
            label="incident angle"
            format={(v) => `${v.toFixed(1)}°`}
          />
          <ControlToggle of={showWave} label="traveling wave (off = what film sees)" />
        </div>
        <div class="readouts">
          <div>
            <span class="rd-num">
              {zoneLocalPitch(zoneF.get(), lambda.get(), 60).toFixed(0)} µm
            </span>
            <span class="rd-lbl">local pitch Λ(x) at x = 60 µm</span>
          </div>
          <div>
            <span class="rd-num">
              {zoneLocalPitch(zoneF.get(), lambda.get(), 240).toFixed(0)} µm
            </span>
            <span class="rd-lbl">local pitch at the edge (finer = harder kick)</span>
          </div>
          <div>
            <span class="rd-num">{(240 / Math.hypot(240, zoneF.get())).toFixed(2)}</span>
            <span class="rd-lbl">numerical aperture at the edge</span>
          </div>
          <div>
            <span class="rd-num">{((zoneF.get() * lambda.get()) / 240 / 2).toFixed(1)} µm</span>
            <span class="rd-lbl">focal spot ≈ λ·f/W (diffraction limit)</span>
          </div>
        </div>
      </div>
    </div>
  );
}
