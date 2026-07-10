/**
 * Controls.tsx — parameter widgets (playbook layer 3). Sliders bind controls
 * through ControlSlider: bounds/step come from each control's meta in
 * store.ts (declared once — the agent's `set` tool validates through the same
 * numbers), writes go through the control's validation, and each label
 * carries its `data-control` attribution stamp. Nothing here knows WebGL
 * exists.
 */
import { ControlSlider } from "@habemus-papadum/aiui-viz";
import { Show } from "solid-js";
import { brushRadius, history, paramF, paramK, sim, speed } from "../model/store";
import type { SeedKind } from "../sim/gray-scott";

export function Controls() {
  const reseed = (kind: SeedKind) => {
    sim.engine.seed(kind);
    history.clear();
  };
  const paused = () => speed.get() === 0;
  return (
    <div class="controls panel">
      <div class="controls-grid">
        <ControlSlider of={paramF} label="feed F" format={(v) => v.toFixed(4)} />
        <ControlSlider of={paramK} label="kill k" format={(v) => v.toFixed(4)} />
        <ControlSlider
          of={speed}
          label="speed"
          format={(v) => (v === 0 ? "paused" : `${v} steps/frame`)}
        />
        <ControlSlider of={brushRadius} label="brush" format={(v) => v.toFixed(3)} />
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
