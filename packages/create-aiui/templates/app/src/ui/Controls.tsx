// <aiui-scenery-file> — this WHOLE FILE is placeholder scenery: delete it on reset (CLAUDE.md § Reset).
/**
 * Controls.tsx — the sliders, bound through ControlSlider: bounds, step, and
 * unit come from each control's meta (one source of truth for the widget, the
 * keyboard, and the agent's `set` tool), writes validate through the control,
 * and the label carries the `data-control` attribution stamp. Compose widgets
 * into your own layout and prose — there is deliberately no auto-panel.
 */
import { ControlSlider } from "@habemus-papadum/aiui-viz";
import { angleStep, petals } from "../model/store";

export function Controls() {
  return (
    <section class="controls panel">
      <ControlSlider of={angleStep} label="angle step" />
      <ControlSlider of={petals} label="petals" />
    </section>
  );
}
