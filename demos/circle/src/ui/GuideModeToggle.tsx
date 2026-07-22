/**
 * GuideModeToggle.tsx — the segmented switch for the guidance mode (playbook
 * layer 4). A hand-rolled binding to the `guideMode` control (the shapes this
 * needs don't fit ControlSlider/Toggle): it stamps `data-control="guideMode"`
 * itself so a drag over it still resolves to the control, and each button
 * writes through the control's validation. The active mode's blurb sits under
 * the switch so the exercise explains itself.
 */

import type { JSX } from "@solidjs/web";
import { guideMode } from "../model/store";

type Mode = "guide" | "zen" | "blind";

const MODES: { value: Mode; label: string; blurb: string }[] = [
  { value: "guide", label: "Guide", blurb: "Live fit — easiest, but traceable." },
  {
    value: "zen",
    label: "Zen",
    blurb: "Only the fitted centre, ghosting. Focus there; the shape is revealed on lift.",
  },
  {
    value: "blind",
    label: "Blind",
    blurb: "No guide at all — the fit is revealed only when you lift.",
  },
];

export function GuideModeToggle(): JSX.Element {
  const active = () => guideMode.get();
  const blurb = () => MODES.find((m) => m.value === active())?.blurb ?? "";
  return (
    <div class="guide-toggle" data-control="guideMode" title={guideMode.description}>
      <div class="gt-seg">
        {MODES.map((m) => (
          <button
            type="button"
            class={active() === m.value ? "gt-btn active" : "gt-btn"}
            onClick={() => guideMode.set(m.value)}
          >
            {m.label}
          </button>
        ))}
      </div>
      <div class="gt-blurb">{blurb()}</div>
    </div>
  );
}
