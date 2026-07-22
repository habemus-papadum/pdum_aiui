import { ControlSlider } from "@habemus-papadum/aiui-viz";
/**
 * Controls.tsx — the page's own (non-vgplot) controls: the completeness
 * magnitude Mc slider that drives the live b-value fit, a one-click "use
 * suggested Mc" (the max-curvature estimate from the current selection), and a
 * reset that clears every crossfilter clause. Mc is a durable signal, so it
 * survives hot edits; clearing filters walks the shared selection's clauses.
 */
import { Show } from "solid-js";
import { seismosGraph } from "../graph";
import { store } from "../store";

function clearFilters() {
  for (const c of [...store.brush.clauses]) {
    store.brush.update({ ...c, value: null, predicate: null });
  }
}

export function Controls() {
  const suggested = () => seismosGraph().grStats().mcSuggested;
  const active = () => store.brush.clauses.length;
  return (
    <div class="seismos-controls">
      <ControlSlider
        of={store.mc}
        label="completeness"
        class="slider-compact"
        format={(v) => `Mc ${v.toFixed(1)}`}
      />
      <div class="controls-buttons">
        <Show when={suggested() != null}>
          <button
            type="button"
            class="btn btn-outline"
            onClick={() => {
              const s = suggested();
              if (s != null) store.mc.set(s); // the control clamps to [MC_MIN, MC_MAX]
            }}
          >
            use suggested Mc ({(suggested() as number).toFixed(1)})
          </button>
        </Show>
        <button
          type="button"
          class="btn btn-outline"
          onClick={clearFilters}
          disabled={active() === 0}
        >
          reset filters{active() ? ` (${active()})` : ""}
        </button>
      </div>
    </div>
  );
}
