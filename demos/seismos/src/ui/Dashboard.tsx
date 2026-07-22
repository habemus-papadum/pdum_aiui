/**
 * Dashboard.tsx — the observatory: every coordinated view at a glance, all
 * reading and writing the one crossfilter selection. The map (epicenter
 * density), the three histograms (magnitude, depth, time), and the depth-class
 * bar are vgplot islands behind MosaicView; the Gutenberg–Richter panel and the
 * stat tiles are cell-driven Solid. Brush any one and the coordinator re-queries
 * the rest — Mosaic's reactivity and Solid's meet only at the shared selection
 * and the histogram signal.
 *
 * Mounts once (after the loading cell settles). vgplot islands are not DOM
 * singletons — each MosaicView builds its own Plot — so later sections may mount
 * their own copies of a spec, staying in lockstep through the shared brush.
 */
import type { JSX } from "@solidjs/web";
import { Controls } from "./Controls";
import { Facets } from "./Facets";
import { GutenbergRichter } from "./GutenbergRichter";
import { MosaicView } from "./MosaicView";
import { StatTiles } from "./StatTiles";
import { depthClassSpec, depthHistSpec, magHistSpec, mapSpec, timeHistSpec } from "./specs";

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
    <div class="obs">
      <StatTiles />
      <div class="obs-top">
        <Panel
          class="obs-map"
          title="epicenter density"
          sub="the Ring of Fire, drawn by the data — drag a box to filter by region"
        >
          <MosaicView spec={() => mapSpec()} />
          <Facets />
        </Panel>
        <Panel
          class="obs-gr"
          title="Gutenberg–Richter"
          sub="cumulative N(≥M), log scale, with the live b-value fit"
        >
          <GutenbergRichter />
          <Controls />
        </Panel>
      </div>
      <div class="obs-charts">
        <Panel title="magnitude" sub="brush a range">
          <MosaicView spec={() => magHistSpec()} />
        </Panel>
        <Panel title="depth" sub="shallow spike + deep tail">
          <MosaicView spec={() => depthHistSpec()} />
        </Panel>
        <Panel title="time" sub="1976–2024">
          <MosaicView spec={() => timeHistSpec()} />
        </Panel>
        <Panel title="depth class" sub="click to toggle">
          <MosaicView spec={() => depthClassSpec()} />
        </Panel>
      </div>
    </div>
  );
}
