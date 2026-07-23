/**
 * ImagingPanel.tsx — the stripe lens used as optics: a point object, a real
 * image, the lens law and magnification live, and (toggled) the chromatic
 * smear of running a diffractive lens in white light. The ghost dot marks the
 * lens-law prediction; the bright spot in the computed field lands on it.
 */
import { FieldMap } from "@habemus-papadum/aiui-optics/widgets";
import { CellView, ControlSlider, ControlToggle } from "@habemus-papadum/aiui-viz";
import { Show } from "solid-js";
import { graph } from "../model/graph";
import { lambda, objDist, objX, showWave, whiteLight, zoneF } from "../model/store";
import { MapDot, PlaneLine } from "./overlays";

export function ImagingPanel() {
  const numbers = () => graph().lensNumbers();
  return (
    <div class="bench">
      <div class="bench-stage">
        <Show
          when={whiteLight.get()}
          fallback={
            <CellView of={graph().imagingMap} label="imaging bench">
              {(v) => (
                <div class="map-wrap">
                  <FieldMap
                    data={v()}
                    view={showWave.get() ? "wave" : "intensity"}
                    aspect={760 / 560}
                    overlay={
                      <PlaneLine z={0} xHalf={240} color="rgba(190, 160, 110, 0.8)" dash="2 3" />
                    }
                  />
                  <Show when={numbers()?.kind === "real"}>
                    <MapDot
                      extent={v()}
                      z={numbers()?.imageDist ?? 0}
                      x={numbers()?.imageX ?? 0}
                      kind="ghost"
                      label="lens-law image"
                    />
                  </Show>
                </div>
              )}
            </CellView>
          }
        >
          <CellView of={graph().imagingWhiteMap} label="imaging bench (3 λ)">
            {(v) => (
              <div class="map-wrap">
                <FieldMap
                  data={v()}
                  aspect={760 / 560}
                  overlay={
                    <PlaneLine z={0} xHalf={240} color="rgba(190, 160, 110, 0.8)" dash="2 3" />
                  }
                />
                <Show when={numbers()?.kind === "real"}>
                  <MapDot
                    extent={v()}
                    z={numbers()?.imageDist ?? 0}
                    x={numbers()?.imageX ?? 0}
                    kind="ghost"
                    label={`image at λ`}
                  />
                </Show>
              </div>
            )}
          </CellView>
        </Show>
        <p class="map-caption">
          a point source (off-screen left) diverges onto the stripe lens; past it, the +1 order
          converges to a real image — on the ghost dot the lens law predicts
        </p>
      </div>

      <div class="bench-side">
        <div class="controls">
          <ControlSlider of={objDist} label="object distance" format={(v) => `${v} µm`} />
          <ControlSlider of={objX} label="object height" format={(v) => `${v} µm`} />
          <ControlSlider of={zoneF} label="designed focus f" format={(v) => `${v} µm`} />
          <ControlSlider of={lambda} label="wavelength λ" format={(v) => `${v.toFixed(1)} µm`} />
          <ControlToggle of={whiteLight} label="three wavelengths (chromatic blur)" />
          <ControlToggle of={showWave} label="traveling wave (off = what film sees)" />
        </div>
        <CellView of={graph().lensNumbers} label="lens law">
          {(v) => (
            <div class="readouts">
              <div>
                <span class="rd-num">
                  {v().kind === "real" ? `${v().imageDist.toFixed(0)} µm` : "virtual"}
                </span>
                <span class="rd-lbl">image distance (1/zo + 1/zi = 1/f)</span>
              </div>
              <div>
                <span class="rd-num">
                  {v().kind === "real" ? `${Math.abs(v().magnification).toFixed(2)}×` : "—"}
                </span>
                <span class="rd-lbl">magnification |M| = zi/zo (image inverted)</span>
              </div>
              <div>
                <span class="rd-num">
                  {v().fBlue.toFixed(0)} / {v().fRed.toFixed(0)} µm
                </span>
                <span class="rd-lbl">this plate's f at 0.8λ / 1.2λ — dispersion as a lens</span>
              </div>
            </div>
          )}
        </CellView>
      </div>
    </div>
  );
}
