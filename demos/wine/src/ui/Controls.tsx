/**
 * Controls.tsx — the page's non-vgplot controls: reset (clears every
 * crossfilter clause — the same code path as the clear-filters agent tool)
 * and the named-views bar (save/load the dimension state). The clause count
 * reads store.brushSignal — the reactive window — so the label follows every
 * producer, the embedding lasso included.
 */
import { SelectionViewsBar } from "@habemus-papadum/aiui-viz/selection-views";
import { store } from "../model/store";

export function Controls() {
  const active = () => store.brushSignal.clauses().filter((c) => c.predicate != null).length;
  return (
    <div class="wine-controls">
      <button
        type="button"
        class="btn btn-outline"
        onClick={() => store.clearFilters()}
        disabled={active() === 0}
      >
        reset filters{active() ? ` (${active()})` : ""}
      </button>
      <SelectionViewsBar store={store.views} />
    </div>
  );
}
