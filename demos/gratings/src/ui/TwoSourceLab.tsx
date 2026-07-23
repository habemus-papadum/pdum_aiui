/**
 * TwoSourceLab.tsx — the primitive, isolated: two point emitters, their
 * overlapping ripples, a draggable probe with the two-arrow dial, and the
 * screen-line intensity. Everything the rest of the notebook does is this
 * picture, N times over.
 */
import { FieldMap, FilmStrip, PhasorDial } from "@habemus-papadum/aiui-optics/widgets";
import { CellView, ControlSlider, ControlToggle } from "@habemus-papadum/aiui-viz";
import { SCREEN_Z } from "../model/bench";
import { graph } from "../model/graph";
import { probeX, probeZ, showWave, srcSep } from "../model/store";
import { css, MapDot, PlaneLine } from "./overlays";

export function TwoSourceLab() {
  return (
    <div class="bench">
      <div class="bench-stage">
        <CellView of={graph().twoSrcMap} label="two-source map">
          {(v) => (
            <div class="map-wrap">
              <FieldMap
                data={v()}
                view={showWave.get() ? "wave" : "intensity"}
                aspect={760 / 660}
                onProbe={(p) => {
                  probeX.set(Math.round(p.x));
                  probeZ.set(Math.round(p.z));
                }}
                overlay={<PlaneLine z={SCREEN_Z} xHalf={330} />}
              />
              <MapDot extent={v()} z={probeZ.get()} x={probeX.get()} kind="probe" />
              <MapDot extent={v()} z={0} x={-srcSep.get() / 2} kind="source" color="#7aa2f7" />
              <MapDot extent={v()} z={0} x={srcSep.get() / 2} kind="source" color="#f0a35e" />
            </div>
          )}
        </CellView>
        <p class="map-caption">
          two emitters fed by one laser — drag anywhere on the map to move the probe; the dashed
          column is the screen
        </p>
      </div>

      <div class="bench-side">
        <div class="controls">
          <ControlSlider of={srcSep} label="separation d" format={(v) => `${v} µm`} />
          <ControlSlider of={probeX} label="probe x" format={(v) => `${v} µm`} />
          <ControlSlider of={probeZ} label="probe z" format={(v) => `${v} µm`} />
          <ControlToggle of={showWave} label="traveling wave (off = what film sees)" />
        </div>
        <CellView of={graph().probeArrows} label="probe arrows">
          {(v) => (
            <div class="dial-box">
              <PhasorDial
                arrows={v().arrows}
                resultantColor={css(v().tint)}
                title="the two arrows at the probe"
              />
              <p class="dial-caption">
                blue arrow from the left source, orange from the right; the yellow resultant is what
                a detector at the probe would read (squared). The spin is e^{"−iωt"} — the shape
                never changes, so the brightness is steady.
              </p>
            </div>
          )}
        </CellView>
      </div>

      <div class="bench-chart">
        <CellView of={graph().screenLine} label="screen intensity">
          {(v) => (
            <FilmStrip data={v().data} x0={v().x0} dx={v().dx} color={v().color} height={40} />
          )}
        </CellView>
        <p class="map-caption">
          intensity along the screen — the fringes a film there would record
        </p>
      </div>
    </div>
  );
}
