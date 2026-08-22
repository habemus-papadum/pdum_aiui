/**
 * App.tsx — the wine page as a short paper with the atlas on top: the full
 * cross-filter dashboard first (everything on screen at load), then the data
 * and the mechanism. The loading cell (graph().dataset) gates the dashboard
 * with real download progress — the two parquets are ~64 MB on first visit
 * and land in the browser cache for the next one.
 */
import { CellView } from "@habemus-papadum/aiui-viz";
import { TocRail } from "@habemus-papadum/aiui-viz/site";
import { graph } from "../model/graph";
import { store } from "../model/store";
import { Dashboard } from "./Dashboard";

function LoadingPanel() {
  const pct = () => Math.round(store.loadProgress() * 100);
  return (
    <div class="loading-panel">
      <div class="loading-title">loading the wine reviews…</div>
      <div class="loading-bar">
        <div class="loading-bar-fill" style={{ width: `${Math.max(4, pct())}%` }} />
      </div>
      <div class="loading-sub">
        two Parquet files (~64 MB, cached after the first visit) → DuckDB-WASM · {pct()}%
      </div>
    </div>
  );
}

export function App() {
  return (
    <div class="app wine">
      <div class="app-main">
        <header class="app-head">
          <h1>
            <span class="accent">wine</span> · an embedding atlas of 120k tasting notes
          </h1>
          <p class="app-sub">
            Every WineEnthusiast review, embedded by what its text says and projected to a 2-D map
            (Apple's Embedding Atlas view), cross-filtered with Mosaic against score, price,
            variety, and origin — all in your browser.
          </p>
        </header>

        <section id="the-atlas" class="page-section">
          <h2>the atlas</h2>
          <p class="section-lead">
            Two maps of the same 120,000 reviews. The <b>tasting-note map</b> places reviews whose{" "}
            <i>descriptions</i> read alike near each other — crisp Rieslings pool far from jammy
            Zinfandels — colored by grape variety. The <b>world map</b> puts each review at its
            region of origin. Both read and write one cross-filter: lasso a flavor cluster and the
            world map shows where it's grown; box a country and the tasting-note map shows what it
            tastes like. Brush a score or price range, click a variety, pick a country — every view
            follows.
          </p>
          <CellView of={graph().dataset} label="loading reviews" fallback={<LoadingPanel />}>
            {() => <Dashboard />}
          </CellView>
        </section>

        <section id="the-data" class="page-section">
          <h2>the data</h2>
          <p class="prose">
            ~120,000 deduplicated reviews from the <b>WineEnthusiast</b> catalog (HuggingFace{" "}
            <span class="mono">spawn99/wine-reviews</span>, CC BY-NC-SA 4.0), each with a title,
            country, province, variety, critic score (80–100 points), price, and the tasting note
            itself. The 2-D placement is <b>precomputed</b>: Apple publishes the projected text
            embedding of each note beside their own wine demo, keyed by a deterministic row id —
            this page reproduces their join SQL byte for byte, loads both files into{" "}
            <b>DuckDB-WASM</b>, and derives one extra column: the top-9 varieties as 0-indexed
            categories for the map's colors.
          </p>
          <p class="prose">
            The <b>world map</b> is geocoded at province level: a curated lookup of all 478{" "}
            <span class="mono">(country, province)</span> pairs — Natural Earth admin-1 centroids
            where the province is a real administrative unit, hand-placed centroids for wine regions
            like Bordeaux, Kamptal, or the Colchagua Valley, country fallbacks for the tail —
            covering 97.5% of reviews at region precision. Each review gets a small deterministic
            jitter (~±0.4°) so a province reads as a cloud instead of one stacked point, and the
            Equal-Earth projection is baked into table columns at load, so the density raster and
            the brush work in flat, linear coordinates.
          </p>
        </section>

        <section id="how-it-connects" class="page-section">
          <h2>how it connects</h2>
          <p class="prose">
            The embedding view is a stock <span class="mono">EmbeddingViewMosaic</span> from{" "}
            <span class="mono">embedding-atlas</span> — but a first-class citizen of this page's
            Mosaic crossfilter: its <span class="mono">filter</span> prop is the same Selection the
            histograms brush into, and its rectangle/lasso publishes clauses back into it, exactly
            like a vgplot interactor. The aiui bridge adds identity: the view registers as the
            producer <span class="mono">wine/embedding</span>, so the inspector below names its
            clause, <span class="ctrl">clear-selection</span> can reset it, and the{" "}
            <span class="ctrl">set-projx</span>/<span class="ctrl">set-projy</span> agent tools draw
            a real box on the map (a spoken region and a mouse lasso are one producer).
          </p>
        </section>

        <section id="experiments" class="page-section">
          <h2>experiments</h2>
          <p class="section-lead">Things to try — each names the exact control.</p>
          <ul class="experiments">
            <li>
              Click <b>Riesling</b> in the <span class="ctrl">variety</span> bar: the map collapses
              to the white-wine shore — petrol, lime, and slate live close together.
            </li>
            <li>
              Brush <span class="ctrl">points</span> to 95–100: prestige clusters light up, and the{" "}
              <b>median price</b> tile jumps.
            </li>
            <li>
              Lasso one tight cluster on the <span class="ctrl">tasting-note map</span> and read the{" "}
              <span class="ctrl">variety</span> bar — a good cluster is usually one grape from one
              place.
            </li>
            <li>
              Pick <b>Portugal</b> in the <span class="ctrl">country</span> menu, then hover the
              map's dense spots to read the notes.
            </li>
            <li>
              Drag a box over <b>France</b> on the <span class="ctrl">world</span> map, then over{" "}
              <b>Chile</b>: watch the tasting-note map's lit regions swap — same grapes, different
              vocabularies.
            </li>
            <li>
              Lasso the Riesling shore on the <span class="ctrl">tasting-note map</span> and read
              the <span class="ctrl">world</span> map: Mosel, Alsace, the Finger Lakes, and
              Australia's Clare Valley light up together.
            </li>
            <li>
              <span class="ctrl">reset filters</span> brings the whole catalog back; the
              selection-state panel shows every producer's clause while you explore.
            </li>
          </ul>
        </section>
      </div>
      <TocRail />
    </div>
  );
}
