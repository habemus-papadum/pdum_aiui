/**
 * Controls.tsx — the sliders. Each writes a plain durable signal; the graph
 * recomputes the picture from it, and the picture re-renders. There is no
 * wiring between this file and graph.ts beyond the signals in store.ts — that
 * is the whole point of the dataflow.
 */
import {
  ANGLE_STEP_MAX,
  ANGLE_STEP_MIN,
  angleStep,
  PETALS_MAX,
  PETALS_MIN,
  petals,
} from "../model/store";

export function Controls() {
  return (
    <section class="controls panel">
      <label class="slider">
        <span class="slider-label">
          angle step <b>{angleStep.get()}°</b>
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
      <label class="slider">
        <span class="slider-label">
          petals <b>{petals.get()}</b>
        </span>
        <input
          type="range"
          min={PETALS_MIN}
          max={PETALS_MAX}
          step={1}
          value={petals.get()}
          onInput={(e) => petals.set(e.currentTarget.valueAsNumber)}
        />
      </label>
    </section>
  );
}
