/**
 * Params.tsx — the knobs.
 *
 * Every slider here binds through `ControlSlider`, which reads its bounds, step,
 * and unit from the control's own declaration in store.ts. That is not tidiness:
 * it means a human dragging a slider and an agent calling `set` go through the
 * *same* validation, and the min/max exists in exactly one place. Re-stating a
 * range in JSX is how the two drift.
 */

import { ControlSlider, ControlToggle } from "@habemus-papadum/aiui-viz";
import type { JSX } from "@solidjs/web";
import { clearAnimated, clearStrokes, loadPreset, undo } from "../model/graph";
import {
  beta,
  cuspAngle,
  cuspWindow,
  fadeSec,
  fillDabs,
  flow,
  grain,
  grainScale,
  minCutoff,
  preset,
  pressureAlphaFloor,
  pressureRadiusFloor,
  retention,
  showCusps,
  showDabs,
  showFiltered,
  showRaw,
  size,
  spacing,
  tiltAlphaGain,
  tiltRadiusGain,
  tiltToEccentricity,
  tool,
  velocityAlphaGain,
  velocityRef,
} from "../model/store";

export function Params(): JSX.Element {
  return (
    <section class="panel" id="params">
      <h2>The pencil</h2>

      <div class="row">
        <label class="slider" data-control={preset.name}>
          <span class="slider-label">preset</span>
          <select
            name={preset.name}
            value={preset.get()}
            onInput={(e) => preset.set(e.currentTarget.value as never)}
          >
            <option value="write">write</option>
            <option value="sketch">sketch</option>
            <option value="auto">auto (= write, reserved)</option>
          </select>
        </label>
        <button type="button" class="btn" onClick={() => loadPreset.run?.()}>
          Load
        </button>
        <button type="button" class="btn" onClick={() => undo.run?.()}>
          Undo
        </button>
        <button type="button" class="btn" onClick={() => clearStrokes.run?.()}>
          Clear
        </button>
        <button type="button" class="btn" onClick={() => clearAnimated.run?.()}>
          Clear ✨
        </button>
      </div>

      <h3>Tool</h3>
      <div class="row">
        <label class="slider" data-control={tool.name}>
          <span class="slider-label">tool</span>
          <select
            name={tool.name}
            value={tool.get()}
            onInput={(e) => tool.set(e.currentTarget.value as never)}
          >
            <option value="draw">draw</option>
            <option value="erase">erase</option>
          </select>
        </label>
      </div>

      <h3>Conditioning</h3>
      <ControlSlider of={minCutoff} label="jitter floor (minCutoff)" />
      <ControlSlider of={beta} label="responsiveness (beta)" />
      <ControlSlider of={cuspAngle} label="corner threshold" />
      <ControlSlider of={cuspWindow} label="corner window" />

      <h3>The mark</h3>
      <ControlSlider of={size} label="size" />
      <ControlSlider of={spacing} label="dab spacing" />
      <ControlSlider of={flow} label="flow" />

      <h3>Dynamics</h3>
      <ControlSlider of={pressureRadiusFloor} label="radius at zero pressure" />
      <ControlSlider of={pressureAlphaFloor} label="alpha at zero pressure" />
      <ControlSlider of={tiltToEccentricity} label="tilt → ellipse (charcoal)" />
      <ControlSlider of={tiltRadiusGain} label="tilt → radius" />
      <ControlSlider of={tiltAlphaGain} label="tilt → alpha" />
      <ControlSlider of={velocityAlphaGain} label="speed → alpha" />
      <ControlSlider of={velocityRef} label="speed reference" />

      <h3>Paper</h3>
      <ControlSlider of={grain} label="grain (paper tooth)" />
      <ControlSlider of={grainScale} label="tooth size" />

      <h3>Vanishing ink</h3>
      <ControlSlider of={fadeSec} label="fade (0 = permanent)" />
      <ControlSlider of={retention} label="retention = undo depth" />

      <h3>Diagnostic overlay</h3>
      <div class="checks">
        <ControlToggle of={showRaw} label="raw samples" />
        <ControlToggle of={showFiltered} label="filtered" />
        <ControlToggle of={showCusps} label="corners" />
        <ControlToggle of={showDabs} label="dabs" />
        <ControlToggle of={fillDabs} label="fill dabs" />
      </div>
    </section>
  );
}
