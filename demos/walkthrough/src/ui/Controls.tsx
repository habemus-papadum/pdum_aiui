/**
 * Controls.tsx — the surface's widgets (playbook layer 3). Sliders bind
 * through ControlSlider (bounds/step/unit from each control's meta — declared
 * once in store.ts, shared with the agent's `set` tool); the initial-condition
 * enum is a plain <select> over the control's `options` meta — a hand-rolled
 * binding for a shape the porcelain doesn't cover yet, which is exactly how
 * porcelain candidates get their evidence.
 */
import { ControlSlider } from "@habemus-papadum/aiui-viz";
import { For } from "solid-js";
import type { InitialCondition } from "../lib/diffusion";
import { ic, kappa, points, simTime } from "../model/store";

export function Controls() {
  return (
    <div class="controls panel">
      <ControlSlider of={kappa} label="diffusion κ" format={(v) => v.toFixed(2)} />
      <ControlSlider of={points} label="resolution" format={(v) => `${v} pts`} />
      <ControlSlider of={simTime} label="duration" format={(v) => `${v.toFixed(3)} s`} />
      <label class="select" data-control={ic.name} title={ic.description}>
        <span class="slider-label">profile</span>
        <select value={ic.get()} onInput={(e) => ic.set(e.currentTarget.value as InitialCondition)}>
          <For each={ic.meta.options}>{(kind) => <option value={kind}>{kind}</option>}</For>
        </select>
      </label>
    </div>
  );
}
