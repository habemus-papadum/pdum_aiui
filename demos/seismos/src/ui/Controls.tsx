import { ControlSlider } from "@habemus-papadum/aiui-viz";
import { SelectionViewsBar } from "@habemus-papadum/aiui-viz/selection-views";
/**
 * Controls.tsx — the page's own (non-vgplot) controls: the completeness
 * magnitude Mc slider that drives the live b-value fit, a one-click "use
 * suggested Mc" (the max-curvature estimate from the current selection), a
 * reset that clears every crossfilter clause (store.clearFilters — the same
 * code the clear-filters agent tool runs), and the named-views bar (save/load
 * the dimension state; the same store the view agent tools drive). The clause
 * count reads store.brushSignal — the REACTIVE window onto the brush — so the
 * label follows every producer (a bare `brush.clauses.length` is an untracked
 * read that only refreshed by accident).
 */
import { Show } from "solid-js";
import { seismosGraph } from "../graph";
import { store } from "../store";

export function Controls() {
  const suggested = () => seismosGraph().grStats().mcSuggested;
  const active = () => store.brushSignal.clauses().length;
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
          onClick={() => store.clearFilters()}
          disabled={active() === 0}
        >
          reset filters{active() ? ` (${active()})` : ""}
        </button>
      </div>
      <SelectionViewsBar store={store.views} />
    </div>
  );
}
