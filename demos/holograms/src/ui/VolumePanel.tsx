/**
 * VolumePanel.tsx — the thick-film section: the emulsion as a Bragg stack,
 * its reflectance curve painted in the colors it actually reflects, and the
 * four knobs a volume-hologram designer owns (thickness, modulation,
 * processing shrinkage, viewing tilt).
 */
import { waveColorCss } from "@habemus-papadum/aiui-optics";
import { CellView, ControlSlider } from "@habemus-papadum/aiui-viz";
import { LAMBDA_BAND } from "../model/bench";
import { graph } from "../model/graph";
import { braggDeltaN, braggPeriods, braggShrink, braggTilt, lambdaRec } from "../model/store";
import { SpectrumChart } from "./SpectrumChart";

export function VolumePanel() {
  return (
    <div class="bench">
      <div class="bench-stage">
        <CellView of={graph().braggSelect} label="Bragg selection">
          {(v) => (
            <SpectrumChart
              lambdas={v().lambdas}
              reflect={v().reflect}
              peakLambda={v().peakLambda}
            />
          )}
        </CellView>
        <p class="map-caption">
          white light in (the faint backdrop is the whole band) — what the layered emulsion hands
          back, drawn in its own colors
        </p>
      </div>
      <div class="bench-side">
        <div class="controls">
          <ControlSlider
            of={braggPeriods}
            label="thickness (fringe layers)"
            format={(v) => `${v}`}
          />
          <ControlSlider
            of={braggDeltaN}
            label="index modulation Δn"
            format={(v) => v.toFixed(3)}
          />
          <ControlSlider
            of={braggShrink}
            label="processing shrinkage"
            format={(v) => `${v.toFixed(1)}%`}
          />
          <ControlSlider of={braggTilt} label="viewing tilt" format={(v) => `${v}°`} />
          <ControlSlider of={lambdaRec} label="recording λ" format={(v) => `${v.toFixed(1)} µm`} />
        </div>
        <CellView of={graph().braggSelect} label="Bragg numbers">
          {(v) => (
            <div class="readouts">
              <div>
                <span class="rd-num">
                  <span
                    class="color-chip"
                    style={{ background: waveColorCss(v().peakLambda, LAMBDA_BAND) }}
                  />
                  {v().peakLambda.toFixed(1)} µm
                </span>
                <span class="rd-lbl">the color it picks from white light</span>
              </div>
              <div>
                <span class="rd-num">{(v().peakR * 100).toFixed(0)}%</span>
                <span class="rd-lbl">peak reflectance</span>
              </div>
              <div>
                <span class="rd-num">{v().fwhm.toFixed(2)} µm</span>
                <span class="rd-lbl">bandwidth (thicker film → purer color)</span>
              </div>
            </div>
          )}
        </CellView>
      </div>
    </div>
  );
}
