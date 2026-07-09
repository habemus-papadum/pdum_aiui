/**
 * Controls.tsx — the slider and the key-hint bar. The slider writes a plain
 * durable signal; the graph recomputes the picture from it. The hint bar is
 * rendered from the SAME bindings that execute (keyHints/tap in modal.ts), so
 * what it shows can never drift from what the keys do.
 */
import { For, Show } from "solid-js";
import { hints, tap } from "../model/modal";
import { ANGLE_STEP_MAX, ANGLE_STEP_MIN, angleStep, mode } from "../model/store";

export function Controls() {
  return (
    <section class="controls panel">
      <label class="slider" data-tunes="angleStep">
        <span class="slider-label">
          angle step <b>{angleStep.get()}°</b>
          <Show when={mode.get() === "tune"}>
            <span class="mode-chip">tuning</span>
          </Show>
        </span>
        <input
          type="range"
          min={ANGLE_STEP_MIN}
          max={ANGLE_STEP_MAX}
          step={1}
          value={angleStep.get()}
          onInput={(e) => angleStep.set(e.currentTarget.valueAsNumber)}
        />
      </label>
      <div class="hints">
        <For each={hints()}>
          {(h) => (
            <button
              type="button"
              class="hint"
              disabled={!h.tapKey}
              onClick={() => h.tapKey && tap(h.tapKey)}
            >
              <Show when={h.icon}>
                <span class="hint-icon">{h.icon}</span>
              </Show>
              <kbd>{h.key}</kbd>
              <span class="hint-label">{h.label}</span>
            </button>
          )}
        </For>
      </div>
    </section>
  );
}
