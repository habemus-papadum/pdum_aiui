/**
 * Embedding.tsx — the page's binding of the aiui-viz embedding bridge
 * (`@habemus-papadum/aiui-viz/embedding` → embedding-atlas's
 * EmbeddingViewMosaic) to the durable wine store. One view, three wires:
 *
 *  - `filter` = the crossfilter, so histogram brushes, the variety toggle,
 *    and the country menu re-query the point cloud;
 *  - `rangeSelection` = the same crossfilter, so a rectangle or lasso drawn
 *    here narrows every other view (its clause self-excludes this view);
 *  - `name` = "wine/embedding" — the producer the projx/projy region binding
 *    adopts (store.ts), which is what makes `set-projx`/`set-projy` draw the
 *    on-map box and a mouse lasso mirror back into the dims.
 *
 * viewOptions is the reactive skin: per-mode color scheme and the SAME
 * categorical palette the variety bar wears, so a cluster and its bar match.
 */

import { mode } from "@habemus-papadum/aiui-journal";
import { EmbeddingView } from "@habemus-papadum/aiui-viz/embedding";
import { appScope, store } from "../model/store";
import { wine } from "../palette";

export function Embedding(props: { class?: string }) {
  return (
    <EmbeddingView
      coordinator={store.coordinator}
      table={store.table}
      x="projection_x"
      y="projection_y"
      category="variety_cat"
      text="description"
      identifier="id"
      filter={store.brush}
      rangeSelection={store.brush}
      scope={appScope}
      name="embedding"
      viewOptions={() => ({
        config: { colorScheme: mode() },
        categoryColors: wine().categories,
      })}
      {...(props.class !== undefined ? { class: props.class } : {})}
    />
  );
}
