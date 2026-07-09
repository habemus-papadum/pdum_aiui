/**
 * Controls.tsx — parameter widgets. Sliders write plain durable signals; the
 * graph's effects push them into the sim. Nothing here knows WebGL exists.
 */
import { Show } from "solid-js";
import { brushRadius, history, paramF, paramK, sim, speed } from "../model/store";
import type { SeedKind } from "../sim/gray-scott";

function Slider(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format?: (v: number) => string;
  onInput: (v: number) => void;
}) {
  const shown = () => (props.format ?? ((v: number) => v.toFixed(4)))(props.value);
  return (
    <label class="slider">
      <span class="slider-label">
        {props.label} <b>{shown()}</b>
      </span>
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onInput={(e) => props.onInput(e.currentTarget.valueAsNumber)}
      />
    </label>
  );
}

export function Controls() {
  const reseed = (kind: SeedKind) => {
    sim.engine.seed(kind);
    history.clear();
  };
  const paused = () => speed.get() === 0;
  return (
    <div class="controls panel">
      <div class="controls-grid">
        <Slider
          label="feed F"
          value={paramF.get()}
          min={0.005}
          max={0.09}
          step={0.0005}
          onInput={paramF.set}
        />
        <Slider
          label="kill k"
          value={paramK.get()}
          min={0.03}
          max={0.075}
          step={0.0005}
          onInput={paramK.set}
        />
        <Slider
          label="speed"
          value={speed.get()}
          min={0}
          max={48}
          step={1}
          format={(v) => (v === 0 ? "paused" : `${v} steps/frame`)}
          onInput={speed.set}
        />
        <Slider
          label="brush"
          value={brushRadius.get()}
          min={0.01}
          max={0.12}
          step={0.005}
          format={(v) => v.toFixed(3)}
          onInput={brushRadius.set}
        />
      </div>
      <div class="controls-buttons">
        <button type="button" class="btn" onClick={() => speed.set(paused() ? 12 : 0)}>
          <Show when={paused()} fallback={<>‖ pause</>}>
            ▶ resume
          </Show>
        </button>
        <button type="button" class="btn" onClick={() => reseed("center")}>
          seed center
        </button>
        <button type="button" class="btn" onClick={() => reseed("spots")}>
          seed spots
        </button>
        <button type="button" class="btn" onClick={() => reseed("noise")}>
          seed noise
        </button>
        <button type="button" class="btn btn-outline" onClick={() => reseed("clear")}>
          clear
        </button>
      </div>
    </div>
  );
}
