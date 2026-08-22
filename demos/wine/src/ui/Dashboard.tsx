/**
 * Dashboard.tsx — the atlas at a glance: the embedding map of 120k tasting
 * notes in the center (embedding-atlas's EmbeddingViewMosaic behind the
 * aiui-viz bridge), the coordinated side panels (points, price, variety,
 * country) around it, all reading and writing the one crossfilter Selection,
 * and the selection inspector below. Draw a rectangle or lasso on the map
 * and every histogram re-counts; brush a histogram and the map re-queries.
 */
import { SelectionInspector } from "@habemus-papadum/aiui-viz/selection-inspector";
import type { JSX } from "@solidjs/web";
import { appScope, store } from "../model/store";
import { Controls } from "./Controls";
import { Embedding } from "./Embedding";
import { Facets } from "./Facets";
import { MosaicView } from "./MosaicView";
import { StatTiles } from "./StatTiles";
import { mapSpec, pointsHistSpec, priceHistSpec, varietyBarSpec } from "./specs";

export function Panel(props: {
  title: string;
  sub?: string;
  children: JSX.Element;
  class?: string;
}) {
  return (
    <div class={props.class ? `panel ${props.class}` : "panel"}>
      <div class="panel-head">
        <h2>{props.title}</h2>
        {props.sub ? <span class="panel-sub">{props.sub}</span> : null}
      </div>
      {props.children}
    </div>
  );
}

export function Dashboard() {
  return (
    <div class="atlas">
      <StatTiles />
      <div class="atlas-main">
        <div class="atlas-maps">
          <Panel
            class="atlas-map"
            title="the tasting-note map"
            sub="every review, placed by what its text says — drag a region or lasso a cluster to filter"
          >
            <Embedding class="atlas-embedding" />
          </Panel>
          <Panel
            class="atlas-world"
            title="the world"
            sub="the same reviews at their region of origin — drag a box to filter by geography"
          >
            <MosaicView name="map" spec={() => mapSpec()} />
          </Panel>
        </div>
        <div class="atlas-side">
          <Panel title="variety" sub="click to toggle — colors match the map">
            <MosaicView name="variety-bar" spec={() => varietyBarSpec()} />
          </Panel>
          <Panel title="points" sub="brush a score range">
            <MosaicView name="points-hist" spec={() => pointsHistSpec()} />
          </Panel>
          <Panel title="price" sub="brush a price range (axis clipped at $200)">
            <MosaicView name="price-hist" spec={() => priceHistSpec()} />
          </Panel>
          <Panel title="origin & views" sub="pick a country; save the current filter state">
            <Facets />
            <Controls />
          </Panel>
        </div>
      </div>
      <Panel
        class="atlas-inspector"
        title="selection state"
        sub="every active clause with its producer, and everything that can filter here"
      >
        <SelectionInspector signal={store.brushSignal} scope={appScope} />
      </Panel>
    </div>
  );
}
