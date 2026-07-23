/**
 * KitPanel.tsx — the bench kit as failure modes: the laser's coherence length
 * against the path-matching trombone, and vibration against the fringes. The
 * exposure strip IS the meter — fringes die in front of you, and the film
 * develops into nothing.
 */
import { FilmStrip } from "@habemus-papadum/aiui-optics/widgets";
import { CellView, ControlSlider } from "@habemus-papadum/aiui-viz";
import { graph } from "../model/graph";
import { coherenceLen, pathTrim, vibration } from "../model/store";

export function KitPanel() {
  return (
    <div class="bench">
      <div class="bench-stage">
        <CellView of={graph().exposure} label="exposure">
          {(v) => (
            <FilmStrip
              data={v().exposure}
              x0={v().x0}
              dx={v().dx}
              color={v().tint}
              normalize="mean"
              height={46}
            />
          )}
        </CellView>
        <p class="map-caption">
          the exposure the film integrates — watch the fringe contrast as you detune the bench
        </p>
      </div>
      <div class="bench-side">
        <div class="controls">
          <ControlSlider of={pathTrim} label="reference path trim" format={(v) => `${v} µm`} />
          <ControlSlider of={coherenceLen} label="coherence length" format={(v) => `${v} µm`} />
          <ControlSlider
            of={vibration}
            label="bench vibration"
            format={(v) => `${v.toFixed(2)} λ rms`}
          />
        </div>
        <CellView of={graph().benchNumbers} label="contrast">
          {(v) => (
            <div class="readouts">
              <div class={v().contrast > 0.5 ? "" : "warn"}>
                <span class="rd-num">{(v().contrast * 100).toFixed(0)}%</span>
                <span class="rd-lbl">fringe contrast (the exposure's usable signal)</span>
              </div>
              <div>
                <span class="rd-num">{v().meanPath.toFixed(0)} µm</span>
                <span class="rd-lbl">object arm's mean path (trim ≈ 0 keeps arms matched)</span>
              </div>
            </div>
          )}
        </CellView>
      </div>
    </div>
  );
}
