/**
 * PlaybackPanel.tsx — the three-beam section's bench (playback map + the
 * beam-power split + the separation knob), and the remix section's bench
 * (same map, playback-side knobs: µ, angle, curved-reference recording).
 */
import { CellView, ControlSlider, ControlToggle } from "@habemus-papadum/aiui-viz";
import { graph } from "../model/graph";
import {
  bleach,
  playAngleDeg,
  playScale,
  refAngleDeg,
  refCurved,
  refDist,
  showWave,
} from "../model/store";
import { PlaybackMap } from "./HoloBench";

function SplitChips() {
  return (
    <CellView of={graph().split} label="beam split">
      {(v) => (
        <div class="readouts">
          <div>
            <span class="rd-num">{(v().image * 100).toFixed(1)}%</span>
            <span class="rd-lbl">image beam</span>
          </div>
          <div>
            <span class="rd-num">{(v().zero * 100).toFixed(0)}%</span>
            <span class="rd-lbl">zero order</span>
          </div>
          <div>
            <span class="rd-num">{(v().twin * 100).toFixed(1)}%</span>
            <span class="rd-lbl">conjugate twin</span>
          </div>
        </div>
      )}
    </CellView>
  );
}

export function PlaybackPanel() {
  return (
    <div class="bench">
      <div class="bench-stage">
        <PlaybackMap />
        <p class="map-caption">
          the played-back field: zero order sailing on at the reference angle, the image fan
          rebuilding the scene's wavefront. At the matched angle the twin's foci converge off the
          top of the frame — off-axis separation doing its job; drop the playback angle and watch
          them swing back in
        </p>
      </div>
      <div class="bench-side">
        <div class="controls">
          <ControlSlider
            of={refAngleDeg}
            label="reference angle"
            format={(v) => `${v.toFixed(1)}°`}
          />
          <ControlToggle of={bleach} label="bleach (phase film)" />
          <ControlToggle of={showWave} label="traveling wave" />
        </div>
        <SplitChips />
      </div>
    </div>
  );
}

export function RemixPanel() {
  return (
    <div class="bench">
      <div class="bench-stage">
        <PlaybackMap showEye />
        <p class="map-caption">
          remix bench: the ghost dots are the paraxial predictions under the CURRENT playback — drag
          µ and watch the virtual images pull toward the film; drop the playback angle and the twin
          foci swing into frame
        </p>
      </div>
      <div class="bench-side">
        <div class="controls">
          <ControlSlider
            of={playScale}
            label="playback λ (µ×)"
            format={(v) => `${v.toFixed(2)}×`}
          />
          <ControlSlider
            of={playAngleDeg}
            label="playback angle"
            format={(v) => `${v.toFixed(1)}°`}
          />
          <ControlToggle of={refCurved} label="record with spreading-lens reference" />
          <ControlSlider of={refDist} label="spreading-lens distance" format={(v) => `${v} µm`} />
        </div>
        <CellView of={graph().ghosts} label="predicted images">
          {(v) => (
            <div class="readouts">
              <div>
                <span class="rd-num">
                  {v()
                    .filter((g) => g.image.kind === "virtual")
                    .map((g) => `${(-(g.image.z ?? 0)).toFixed(0)}`)
                    .join(" / ") || "—"}
                </span>
                <span class="rd-lbl">virtual image depths, µm (scale as 1/µ)</span>
              </div>
              <div>
                <span class="rd-num">
                  {v()[0]?.image.magnification !== undefined
                    ? `${(v()[0].image.magnification ?? 1).toFixed(2)}×`
                    : "—"}
                </span>
                <span class="rd-lbl">transverse magnification of P1</span>
              </div>
            </div>
          )}
        </CellView>
      </div>
    </div>
  );
}
