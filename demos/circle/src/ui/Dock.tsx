/**
 * Dock.tsx — the control dock (playbook layer 4 furniture): the vanishing-ink
 * lifetime and brush-size sliders (bound straight to the controls, bounds from
 * their meta) plus a clear button. The same knobs the agent moves through `set`
 * and the same clear the `clear` action runs.
 */

import { ControlSlider } from "@habemus-papadum/aiui-viz";
import type { JSX } from "@solidjs/web";
import { brushSize, fadeSeconds, paper, resetTurn } from "../model/store";

export function Dock(): JSX.Element {
  const clear = (): void => {
    paper.clearAnimated();
    resetTurn();
  };
  return (
    <div class="dock">
      <ControlSlider of={fadeSeconds} label="Ink fade" />
      <ControlSlider of={brushSize} label="Brush" />
      <button type="button" class="btn" onClick={clear}>
        Clear
      </button>
    </div>
  );
}
