# seismos — build notes & findings

The third notebook page: **cross-filtering the global earthquake catalog** in
DuckDB-WASM with Mosaic/vgplot, with the Gutenberg–Richter b-value estimated live
from the current selection. Built to the methodology in
[frontend-design-choices](../../../../../docs/guide/frontend-design-choices.md)
and [frontend-hard-won](../../../../../docs/guide/frontend-hard-won.md); this file
records what the build taught, for folding back into those.

## Dataset

- **What:** USGS ANSS Comprehensive Catalog (ComCat), every reviewed earthquake of
  magnitude ≥ 4.5 worldwide, 1976-01-01 through 2024-12-31 — **269,952 events**.
  Columns: `time` (UTC), `year`, `longitude`, `latitude`, `depth` (km), `mag`,
  `magtype` (mb, mww, mwc, ms, …), `type` (earthquake / nuclear explosion /
  volcanic eruption / …), `depth_class` (shallow <70 km / intermediate 70-300 /
  deep >300).
- **Source:** the FDSN event web service,
  `https://earthquake.usgs.gov/fdsnws/event/1/query?format=csv&minmagnitude=4.5&starttime=…`,
  paged by year (the service caps a response at 20,000 events).
- **License:** U.S. Geological Survey — **public domain** (U.S. government work;
  ComCat data carry no copyright). Attribution to USGS/ANSS is courtesy, not a
  requirement.
- **Size:** a single **4.2 MB Parquet** (ZSTD, `FLOAT` for lat/lon/depth/mag,
  dictionary-encoded strings), committed at `public/data/quakes.parquet`. Built
  once from the CSV with the DuckDB CLI (`COPY … TO … (FORMAT parquet, COMPRESSION
  zstd)`); the fetch/convert script is not committed (the parquet is the artifact).
- **Timezone gotcha:** `read_csv` auto-typed the `Z`-suffixed `time` column as
  `TIMESTAMPTZ`; casting to `TIMESTAMP` then rendered in the machine's local zone
  (min shifted to 1975-12-31). Fixed with `SET TimeZone='UTC'` before the cast, so
  the stored naive timestamps are UTC wall-clock and bin identically regardless of
  the browser's zone.

## The DuckDB-WASM + Vite recipe (no CDN)

The site deploys to S3 under base `/aiui/` and must not depend on jsDelivr. Mosaic's
`wasmConnector()` by default instantiates DuckDB from `getJsDelivrBundles()` (CDN),
so instead we **build our own `AsyncDuckDB` from locally-bundled assets and hand it
to the connector** (`store.ts` → `duckdb.ts`):

```ts
// duckdb.ts — Vite emits each of these as a first-class asset (?url)
import mvpWasm   from "@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url";
import mvpWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url";
import ehWasm    from "@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url";
import ehWorker  from "@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url";
const BUNDLES = { mvp: {mainModule: mvpWasm, mainWorker: mvpWorker},
                  eh:  {mainModule: ehWasm,  mainWorker: ehWorker} };
const bundle = await duckdb.selectBundle(BUNDLES);
const worker = new Worker(bundle.mainWorker);       // same-origin → plain Worker,
const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker); // no Blob shim
await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
// store.ts:
coordinator.databaseConnector(wasmConnector({ duckdb: db, connection }));
```

Findings:

- **Pin `@duckdb/duckdb-wasm` to the exact version `@uwdata/mosaic-core` depends
  on** (here `1.33.1-dev45.0`). Our hand-built `AsyncDuckDB` must be the same class
  the connector calls methods on; a second copy in the tree breaks it (and TS flags
  the instance as structurally incompatible). Add mosaic's sub-packages
  (`mosaic-core`, `mosaic-sql`, `mosaic-plot`, `mosaic-inputs`) as direct deps at
  vgplot's version so they dedupe.
- **Ship only `mvp` + `eh`, never `coi`.** The threaded/COI bundle needs
  SharedArrayBuffer with COOP/COEP cross-origin-isolation headers we can't set on
  plain S3. `selectBundle` picks `eh` on every modern browser. Verified: the built
  page loads `/aiui/assets/duckdb-eh-*.wasm` + worker locally, no jsDelivr request.
- **`import.meta.env.BASE_URL`** gives the parquet URL that survives the base
  (`/` dev, `/aiui/` build+preview). This works because the *demo app* (not a
  prebuilt library) reads it, so Vite substitutes it at the consumer's build.
- **Verified `vite build` + `vite preview` under `/aiui/`** — the config keys
  `base` on `command === "build" || isPreview` (the ledger's isPreview note), so the
  built assets resolve; zero console errors at
  `http://localhost:5222/aiui/seismos.html`, cross-filter returns 470 nuclear.

## How Mosaic's reactivity coexists with the cells (the seam)

Mosaic owns an entire reactive world of its own: `Selection` → coordinator →
per-client SQL → Arrow → SVG. Solid owns another. **They meet at exactly two
points, both durable:**

1. **The shared `Selection.crossfilter()`** (`store.brush`). Every vgplot view
   filters by it and publishes into it; the agent tools publish into it too. Solid
   never reads Mosaic's SVG.
2. **One signal, `store.histo`.** A custom `MosaicClient` (`stats-client.ts`) is
   connected to the coordinator with `filterBy: brush`; the coordinator re-queries
   it on every selection change and it writes the filtered magnitude histogram into
   a durable Solid signal. From there it is *pure Solid*: `graph.ts`'s `grStats`
   memo runs `gr.ts` (Gutenberg–Richter math) and the tiles / GR plot render.

So Mosaic pushes one value in; Solid derives everything else. The DuckDB instance,
the coordinator, the `quakes` table, the selection, and the stats-client are
**durable roots** (survive HMR); the cell graph, the specs, and the components are
**disposable** (rebuilt over them). A hot edit to a chart spec never re-instantiates
DuckDB or re-downloads the parquet. The vgplot islands live behind one bridge
(`MosaicView.tsx`): a spec (directive list) in, a DOM element out, and on dispose
`coordinator.disconnect(mark)` for every mark — so a hot edit or theme flip doesn't
leak a client.

## Per-mode theming

`prefers-color-scheme`, no toggle (design-choices §8). CSS tokens carry everything
the stylesheet reaches; `palette.ts` holds the literal chart colors, one **validated
set per mode** (dataviz procedure, against each mode's panel surface — dark #171b25,
light #ffffff): the histogram fill, the GR fit line (amber), the three depth classes
(warm→cool, worst-adjacent CVD ΔE ≥ 22), and the density-raster scheme (`inferno`
dark / `YlOrRd` light).

**Mosaic views re-theme by rebuild, not reactively.** The `MosaicView` spec thunk
reads `seismic()`/`plotStyle()` (which read the `mode()` signal), so a live OS theme
flip re-runs the effect, disconnects the old marks, and rebuilds each island with
the new palette. Verified: flipping to light re-tints the raster to `YlOrRd`, the
axis text to the light ink, and every mark — **no stale colors**. The cost is one
re-query per island on a flip (rare, cheap in DuckDB). The GR plot (Observable Plot
via PlotFigure) and the tiles re-theme reactively for free, since they read the mode
signal inside their own options memo.

## Hard-won Mosaic/vgplot findings (fold into the ledger)

1. **A custom `MosaicClient` that aggregates over a group domain is `filterStable`
   by default — and the coordinator's pre-aggregation index applies *interval*
   crossfilter clauses to it but silently drops *point* clauses.** Symptom: brushing
   the magnitude histogram (interval) re-counted correctly, but a `type =
   'nuclear explosion'` menu selection (point clause) left the histogram unchanged.
   Fix: override `get filterStable() { return false }` on the client so the
   coordinator re-runs the real query every time. For a single cheap aggregate over
   270k rows in DuckDB-WASM this is milliseconds, and it makes every clause kind
   filter identically. *(This is the subtlest bug in the build — a categorical
   cross-filter that looks wired but does nothing.)*

2. **A 2-D `clauseIntervals` region clause needs `scales` metadata to resolve in a
   crossfilter; a hand-built one without it does not propagate to any client.** Two
   independent 1-D `clauseInterval` clauses (one on longitude, one on latitude,
   separate sources) filter reliably — the same mechanism as the histogram brushes.
   The agent `set-filter { west,east,south,north }` builds two 1-D clauses for this
   reason. The map's own `intervalXY` interactor *does* pass `scales` (from the
   plot's x/y scales), so its 2-D clause propagates — verified via the interactor's
   `publish()` (a drag reduced the count to a boxed region).

3. **`intervalXY` on a `raster` mark resolves the brush field to NULL** (predicate
   `NULL BETWEEN …`) — a density raster's x/y channels aren't a plain column, so
   `getField(mark, 'x')` returns null. Pass the geographic columns explicitly:
   `intervalXY({ as: brush, xfield: "longitude", yfield: "latitude" })`.

4. **A `mosaic-inputs` Menu bound to a `Selection` is write-only.** It publishes on
   user change but only back-syncs its `<select>` when bound to a scalar `Param`
   (Menu.js) — so clearing the crossfilter elsewhere (reset button, agent, another
   view) leaves the menu showing a stale value while the data is unfiltered. Fixed
   in `Facets.tsx`: subscribe to the brush's `value` event and, when the menu's own
   clause is gone (`brush.clauses.some(c => c.source === menu)` is false), reset the
   `<select>` to its "all" option without re-publishing.

5. **vgplot's `plot()` binds its coordinator via `this`** (`connect(this, …marks)`
   reads `this.context.coordinator`), and mark/interactor/input builders are
   coordinator-agnostic — binding happens only at `coordinator.connect`. So there's
   no need for `createAPIContext`: build `new Plot()` yourself, connect its marks to
   your one durable coordinator, and you keep the marks for a clean
   `disconnect`-on-dispose. `Plot` is exported from `@uwdata/mosaic-plot`;
   `Plot.update()` is argless in vgplot but typed as requiring a `mark` — pass
   `undefined`.

6. **Driving Mosaic brushes from an agent:** the coordinator batches, so a
   `report()` immediately after a `set-filter` reads stale (the ledger's same-tick
   note, confirmed here). Await a task boundary. Also, **d3-brush (the map's 2-D
   brush) can't be reliably driven by synthetic pointer events** in a headless probe
   (its `getScreenCTM`/pointer-capture path) — verify the map instead via the
   interactor's `publish(extent)` or a real drag. The histogram brushes, the
   menus (`<select>` input events), and every agent tool *are* reliably scriptable.

## The science, and how it's checked

- **Gutenberg–Richter** (`gr.ts`, unit-tested): `log₁₀ N(≥M) = a − bM`. The b-value
  is the Aki–Utsu maximum-likelihood estimator with Bender's binning correction,
  `b = log₁₀(e) / (M̄ − (Mc − ΔM/2))`, over events with magnitude ≥ the completeness
  Mc; a-value anchors the line at N(≥Mc); 1σ is Shi & Bolt (1982). Mc defaults to
  4.7 (global M4.5+ completeness), is a slider, and has a data-driven max-curvature
  suggestion. Tests: closed-form exactness on a tiny histogram, **recovery of a
  known b = 1.0 from a synthetic exponential catalog** (Bender's correction lands
  within 0.05), cumulative-curve correctness, and the ≥ Mc / too-few-events guards.
- **The live read-out:** unfiltered, b ≈ 0.87 at Mc 4.7 (a touch under 1 because
  4.7 sits just below true global completeness — bump Mc to ~5 and b rises toward
  1). Nuclear explosions read b ≈ 0.54 (not tectonic); deep-focus quakes ≈ 0.78.
- **Honest caveats stated in the prose:** the rising event count through the decades
  is mostly the *detection network* growing, not seismicity — so completeness itself
  improves over time; and Mc set below the roll-off biases b.
