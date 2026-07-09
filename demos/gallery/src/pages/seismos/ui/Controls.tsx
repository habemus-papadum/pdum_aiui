/**
 * Controls.tsx — the page's own (non-vgplot) controls: the completeness
 * magnitude Mc slider that drives the live b-value fit, a one-click "use
 * suggested Mc" (the max-curvature estimate from the current selection), and a
 * reset that clears every crossfilter clause. Mc is a durable signal, so it
 * survives hot edits; clearing filters walks the shared selection's clauses.
 */
import { Show } from "solid-js";
import { seismosGraph } from "../graph";
import { MC_MAX, MC_MIN, store } from "../store";

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
      <label class="slider slider-compact">
        <span class="slider-label">
          completeness <b>Mc {store.mc.get().toFixed(1)}</b>
        </span>
        <input
          type="range"
          min={MC_MIN}
          max={MC_MAX}
          step="0.1"
          value={store.mc.get()}
          onInput={(e) => store.mc.set(Number(e.currentTarget.value))}
        />
      </label>
      <div class="controls-buttons">
        <Show when={suggested() != null}>
          <button
            type="button"
            class="btn btn-outline"
            onClick={() => {
              const s = suggested();
              if (s != null) store.mc.set(Math.max(MC_MIN, Math.min(MC_MAX, s)));
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
