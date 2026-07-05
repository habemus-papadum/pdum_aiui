/**
 * App.tsx — the seismos page as a paper with the observatory on top. The first
 * section is the full cross-filter dashboard (everything at a glance); the later
 * sections revisit pieces beside the prose and the mathematics that explain them,
 * re-mounting their own live widgets over the same durable selection — brush one
 * copy and every copy follows (design-choices §3).
 *
 * The loading cell (graph.dataset) gates the observatory: spinner + real
 * download progress, then the dashboard; on a fetch error, a retry. Section
 * shells render as soon as the graph exists so the TOC rail is populated
 * immediately; the live widgets inside them wait on `ready`.
 */
import { CellView } from "@habemus-papadum/aiui-viz";
import { SiteHeader, TeX, TocRail } from "@habemus-papadum/aiui-viz/site";
import { Show } from "solid-js";
import { BRAND, LINKS, TABS } from "../../../site/nav";
import { seismosGraph } from "../graph";
import { store } from "../store";
import { Dashboard, Panel } from "./Dashboard";
import { GutenbergRichter } from "./GutenbergRichter";
import { MosaicView } from "./MosaicView";
import { StatTiles } from "./StatTiles";
import { magHistSpec, mapSpec } from "./specs";

const ready = () => store.loadState() === "ready";

function LoadingPanel() {
  const pct = () => Math.round(store.loadProgress() * 100);
  return (
    <div class="loading-panel">
      <div class="loading-title">loading the earthquake catalog…</div>
      <div class="loading-bar">
        <div class="loading-bar-fill" style={{ width: `${Math.max(4, pct())}%` }} />
      </div>
      <div class="loading-sub">DuckDB-WASM + a 4 MB Parquet · {pct()}%</div>
    </div>
  );
}

export function App() {
  return (
    <>
      <SiteHeader brand={BRAND} tabs={TABS} active="seismos" links={LINKS} />
      <div class="app">
        <div class="app-main">
          <header class="app-head">
            <h1>
              <span class="accent">seismos</span> · the shape of global seismicity
            </h1>
            <p class="app-sub">
              Every M≥4.5 earthquake on Earth, 1976–2024 — 269,952 of them — in DuckDB-WASM,
              cross-filtered with Mosaic. Brush a region, a depth, a magnitude band; watch the
              Gutenberg–Richter b-value re-estimate live.
            </p>
          </header>

          <Show when={seismosGraph()} fallback={<p class="app-sub">building dataflow graph…</p>}>
            <section id="the-observatory" class="page-section">
              <h2>the observatory</h2>
              <p class="section-lead">
                The whole catalog at a glance, every panel reading and writing one shared
                cross-filter selection. Drag a box on the map to pick a region; brush the magnitude,
                depth, or time histograms; click a depth class or choose an event type — every other
                view re-counts to match, and the stat tiles and the Gutenberg–Richter fit update
                with them. The sections below revisit the data, the cross-filter mechanism, and the
                law.
              </p>
              <CellView
                of={seismosGraph()?.dataset ?? never()}
                label="loading catalog"
                fallback={<LoadingPanel />}
              >
                {() => <Dashboard />}
              </CellView>
            </section>

            <section id="the-data" class="page-section">
              <h2>the data</h2>
              <p class="section-lead">
                The catalog is the <b>USGS ANSS Comprehensive Catalog</b> (ComCat), every reviewed
                earthquake of magnitude 4.5 and above from 1976 through 2024 — 269,952 events, each
                with an origin time, location (longitude, latitude, depth), magnitude and magnitude
                type, and an event type. It is U.S. Geological Survey public-domain data (see
                NOTES.md for the exact query and license).
              </p>
              <p class="prose">
                It ships as a single 4.2 MB <b>Parquet</b> file (columnar, ZSTD-compressed) served
                from the site's own origin — no CDN. On load, the file is fetched with a real
                progress bar, handed to an in-browser <b>DuckDB-WASM</b> instance built from
                locally-bundled <span class="mono">.wasm</span> assets, and materialized into a{" "}
                <span class="mono">quakes</span> table. <b>Mosaic</b>'s coordinator then talks to
                that same DuckDB through a connector, pushing every view's aggregation down to the
                database. The download is a <span class="ctrl">cell</span> with progress and a retry
                — kill your network and hit Retry to watch it recover.
              </p>
              <Show when={ready()}>
                <StatTiles />
              </Show>
            </section>

            <section id="cross-filtering" class="page-section">
              <h2>cross-filtering</h2>
              <p class="section-lead">
                Every view publishes its brush into one Mosaic <b>Selection</b> built with{" "}
                <span class="mono">Selection.crossfilter()</span>. Cross-filter resolution means a
                view is filtered by <i>all</i> clauses except its own — so brushing the map narrows
                the histograms without the map fighting its own filter. The predicates are compiled
                to SQL and run in DuckDB; nothing round-trips to a server.
              </p>
              <p class="prose">
                Below is the same map and magnitude histogram as above — different DOM, same durable
                selection. Brush a region on one page copy and every copy, here and in the
                observatory, moves together. That is the payoff of keeping the selection a durable
                root and the views disposable.
              </p>
              <Show when={ready()}>
                <div class="pair">
                  <Panel class="obs-map" title="epicenters" sub="drag a region">
                    <MosaicView spec={() => mapSpec(440, 240)} />
                  </Panel>
                  <Panel title="magnitude" sub="re-counts the brushed region">
                    <MosaicView spec={() => magHistSpec(360, 240)} />
                  </Panel>
                </div>
              </Show>
            </section>

            <section id="gutenberg-richter" class="page-section">
              <h2>the Gutenberg–Richter law</h2>
              <p class="section-lead">
                The number of earthquakes of magnitude ≥ M in a region and time window falls off
                exponentially with magnitude — a straight line on a log count axis. This is the{" "}
                <b>Gutenberg–Richter law</b> (1944):
              </p>
              <TeX display tex="\log_{10} N(\!\geq\! M) \;=\; a \;-\; b\,M" />
              <p class="prose">
                The slope <b>b</b> — the "b-value" — is close to 1 for most of the crust; it dips
                where large asperities store stress (locked subduction megathrusts) and rises in
                volcanic and geothermal swarms of many small events. The intercept a measures
                overall productivity. We estimate b by maximum likelihood above the{" "}
                <b>magnitude of completeness</b> <TeX tex="M_c" /> — the magnitude above which the
                catalog records essentially every event — using the Aki–Utsu estimator with Bender's
                binning correction (<TeX tex="\Delta M" /> the 0.1 magnitude bin):
              </p>
              <TeX display tex="b \;=\; \frac{\log_{10} e}{\bar{M} - (M_c - \Delta M/2)}" />
              <p class="prose">
                Below <TeX tex="M_c" /> the line bends down — small quakes go undetected — which is
                exactly why the fit starts at <TeX tex="M_c" />. Drag the{" "}
                <span class="ctrl">completeness Mc</span> slider and watch the fit re-anchor; brush
                a region or a time span and watch <b>b</b> re-estimate from just those events. One
                honest caveat the time histogram makes visible: the rising event count through the
                decades is mostly the <i>detection network</i> growing, not the Earth shaking more —
                so completeness itself improves over time.
              </p>
              <Show when={ready()}>
                <div class="pair">
                  <Panel class="obs-gr" title="frequency–magnitude" sub="live fit of the selection">
                    <GutenbergRichter width={440} height={300} />
                  </Panel>
                  <div class="gr-side">
                    <StatTiles />
                  </div>
                </div>
              </Show>
            </section>

            <section id="experiments" class="page-section">
              <h2>experiments</h2>
              <p class="section-lead">Things to try — each names the exact control.</p>
              <ul class="experiments">
                <li>
                  Drag a box over the <b>Andean margin</b> (western South America) on the{" "}
                  <span class="ctrl">epicenter density</span> map; the{" "}
                  <span class="ctrl">depth</span> histogram grows a deep-focus tail as the Nazca
                  slab descends, and the <b>b-value</b> shifts.
                </li>
                <li>
                  Pick <b>nuclear explosion</b> in the <span class="ctrl">event type</span> menu:
                  the map collapses onto a handful of test sites (Nevada, Novaya Zemlya, Lop Nur,
                  the Korean peninsula) — 470 declared blasts hiding in a quarter-million quakes.
                </li>
                <li>
                  Brush <span class="ctrl">time</span> to 2004–2005, then 2011: the counts spike
                  with the Sumatra–Andaman and Tōhoku aftershock sequences, and the b-value of an
                  aftershock cloud reads high.
                </li>
                <li>
                  Click <b>deep</b> in the <span class="ctrl">depth class</span> bar (&gt; 300 km):
                  the map isolates the Wadati–Benioff zones — deep quakes trace subducting slabs
                  hundreds of km down, only under trenches.
                </li>
                <li>
                  Slide <span class="ctrl">completeness Mc</span> from 4.5 to 6.0: the fit line
                  re-anchors and the <b>b-value ± σ</b> tile changes — set it too low (into the
                  roll-off) and b is biased; the <span class="ctrl">use suggested Mc</span> button
                  jumps to the data-driven estimate.
                </li>
                <li>
                  Brush the <span class="ctrl">magnitude</span> histogram to M ≥ 7 only: the map
                  keeps just the great earthquakes, almost all on subduction megathrusts, and{" "}
                  <span class="ctrl">reset filters</span> brings the whole catalog back.
                </li>
              </ul>
            </section>
          </Show>
        </div>
        <TocRail />
      </div>
    </>
  );
}

/** Unreachable: the CellView is only rendered inside a truthy `seismosGraph()`. */
function never(): never {
  throw new Error("seismos: dataset cell unavailable");
}
