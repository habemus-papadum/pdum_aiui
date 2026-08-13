# seismos — build notes & findings

The third notebook page: **cross-filtering the global earthquake catalog** in
DuckDB-WASM with Mosaic/vgplot, with the Gutenberg–Richter b-value estimated live
from the current selection. Built to the methodology in
[frontend-design-choices](../../../packages/aiui-viz/docs/frontend-design-choices.md)
and [frontend-hard-won](../../../packages/aiui-viz/docs/frontend-hard-won.md); this file
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

### The country-border overlay (map chrome)

- **What:** faint country outlines drawn over the epicenter map so the sparse
  density has geographic anchoring — committed at `public/data/countries-110m.geojson`
  (**165 KB**, 177 features), fetched once during `store.load()` alongside the
  parquet (non-fatal on failure — the map just renders without it).
- **Source & license:** **Natural Earth** 1:110m Admin-0 countries
  (`nvkelso/natural-earth-vector`, `geojson/ne_110m_admin_0_countries.geojson`) —
  **public domain** (Natural Earth is released with no restrictions).
- **Preprocessed at author time** (fetch → transform, script not committed; the
  geojson is the artifact): properties stripped, coordinates rounded to 2 decimals
  (~1 km, far finer than the ~60 km/px map), and every polygon ring converted to a
  `MultiLineString` **split at the antimeridian** (border-only, no fill — see
  finding 6 for why). The single ±180-crossing feature (Russia) is cut cleanly; the
  result has no horizontal streaks.
- **Drawn as a `line` mark, not `geo`** (fixed 2026-07-06): vgplot's `geo` mark,
  fed these features as literal client data on a projection-less plot, renders **no
  mark group at all** — silently. Reproduced standalone (a plot with only
  `geo(features)` + x/y domains: axes render, zero geo paths). The working
  mechanism: `store.load()` flattens the MultiLineStrings into `{lon, lat, ring}`
  vertices (~10.6k points, 290 rings) and the spec draws one `line` mark with
  `z: "ring"` in plain x/y scale space — aligned with the raster by construction.
- **Equal Earth without a projection system** (2026-07-06): the map is a true
  Equal Earth (Šavrič–Patterson–Jenny 2018) with the projection baked into the
  DATA, not the plot. `eq_x`/`eq_y` table columns are computed once in DuckDB at
  load (same polynomial as the JS mirror `equalEarth()` in store.ts, constants
  validated: x_max 2.7066, aspect 2.055); borders and the 30° graticule + world
  outline are pre-projected client-side. Every layer stays in linear x/y space:
  the raster bins in projected — equal-AREA, so density-honest — space
  server-side, and the `intervalXY` brush emits `eq_x/eq_y BETWEEN …`, i.e.
  exactly the on-screen rectangle the user drew; the crossfilter is untouched.
  Since projected x mixes lon and lat, the axes are tickless and the graticule
  is the georeference. Why not Mercator (tried first): it inflates high
  latitudes and dilutes density — the wrong family for a density map. Why not
  Goode homolosine ("the fingers"): its interruptions slice the oceans, i.e.
  the Ring of Fire itself.
- **vgplot client-data marks take only constant or column-name channels**
  (2026-07-06): a function-valued channel (e.g. `strokeOpacity: (d) => …`) on a
  literal-data `line` mark doesn't throw — the mark's `update()` never
  resolves, hanging the whole plot silently. Split by series into separate
  marks with constant channels instead (the graticule grid vs. outline).

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

6. **A projection-less `geo` mark aligns exactly with a lon/lat raster — but the
   opaque raster forces the overlay on top.** The epicenter map plots raw
   `longitude`/`latitude` on linear scales (equirectangular *is* the identity map
   (lon,lat)→(x,y)). Observable Plot's `geo` mark, when the plot has **no
   `projection`**, falls back to `xyProjection` — it passes coordinates straight
   through the x/y scales (`@observablehq/plot/src/projection.js`). So a `geo` mark
   built from country borders in raw lon/lat lands pixel-for-pixel on the raster,
   with none of the fit/inset drift a real projection introduces. Two gotchas:
   (a) the density raster renders as one `<image>` stretched to fill the inner
   frame and is **fully opaque** (its zero-density floor is `inferno`≈black /
   `YlOrRd`≈pale, not transparent) — anything drawn *behind* it is invisible, so
   the overlay must be a later mark (on top), stroked and faint; and (b) without a
   projection there's no antimeridian clipping, so any polygon crossing ±180 would
   streak across the map — pre-cut the geometry into `MultiLineString`s at the
   antimeridian (author-time) rather than relying on Plot to clip. Color is a
   per-mode `coast` + `coastOpacity` in `palette.ts`, tuned as *chrome* (like a
   graticule), exempt from the categorical-CVD checks. Separately, `pixelSize: 1.5`
   on the raster makes each density cell ~50% larger so isolated events read as
   visible specks rather than single pixels.

7. **Driving Mosaic brushes from an agent:** the coordinator batches, so a
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

## Theming: the gallery is dark-only (2026-07-19)

The gallery is now a single **dark journal** — no light mode, no toggle. seismos
once defaulted to light (the epicenter-density map reads better on white) with a
per-page ThemeToggle, but two surfaces across the notebooks read as inconsistent,
so the whole site committed to dark. `index.html`'s head stamps
`data-theme="dark"` before first paint and `@habemus-papadum/aiui-journal` (`mode()`, a
constant `"dark"`) is the source of truth for the literal chart/Plot colors; CSS
goes through the `:root` tokens. The epicenter map keeps working on dark — it was
always a supported mode — it just no longer gets the light surface it preferred.

## Filters are selection dimensions now (2026-08-12)

The hand-written `set-filter` tool (twelve prose-documented args, per-kind
`SRC` source objects, data-bound defaults) is retired. Its seven filter kinds
are declared `selectionDim()`s in store.ts (`aiui-viz/mosaic-selection`):
each is a named, validated writer over the SAME brush — stable per-dimension
clause sources, one-sided ranges built as `>=`/`<=` (so no more filling the
open side from the data summary), a real JSON-Schema'd `set-<dim>` tool each,
and semantic values that survive hot edits alongside the durable brush.
Finding 2's rule (a geographic box = two 1-D clauses) is encoded in the lon +
lat pair. `clear-filters` is now an `action()` backed by `store.clearFilters`,
which clears the dims first (their VALUES too, not just their clauses) and
then retracts every remaining producer's clause — plot brushes and facet menus
included. The reset button's clause count reads `store.brushSignal` (the
`selectionSignal` bridge), fixing the untracked `brush.clauses.length` read
that only refreshed by accident. Named views (`aiui-viz/selection-views`,
localStorage under `aiui:views:seismos`) snapshot dimension VALUES — never
clauses — with `save/load/list/delete-view` tools and the `SelectionViewsBar`
in Controls; what a view cannot capture is a clause from a non-dimension
producer (a map brush, a menu) — those have no serializable identity.

## Theming, reversed: the journal follows the system now (2026-08-12)

The dark-only decision above is superseded. The journal (demos/journal) follows
`prefers-color-scheme` — dark tokens as the base, one light media block, no
toggle, no `data-theme` stamp (the head script and `initTheme()` are deleted;
the UA resolves the media query pre-paint, so nothing flashes). `mode()` is now
REACTIVE (it delegates to aiui-viz's `colorMode()`), which makes every
`seismic()` read inside this demo's spec thunks live: a system theme flip
rebuilds each MosaicView against the surviving coordinator and selections —
the light `palette.ts` block (including the YlOrRd density scheme this page
always wanted on white) finally runs. Plates stay dark in both modes
(`--figure-bg` is a cross-mode constant — the plate rule in the journal's
styles.css header). Verified live across a flip with active filters: a
selection-dimension clause (`mag >= 6`) and a facet-menu clause
(`type IN ('earthquake')`) both survive the MosaicView rebuilds — their
sources (the durable dim source; the Menu client, which lives outside any
MosaicView) are never disposed — with identical filtered counts on the other
side, and zero console errors on a clean load→filter→flip→clear pass. The one
producer that does NOT survive a flip, by design: an in-flight PLOT brush.
The rebuild disposes its interactor, and mosaic.tsx's ghost-clause protection
retracts the disposed interactor's clause (the alternative is a filter with
no rectangle on screen). An OS theme flip is rare enough that losing an
active brush rectangle to it is the right trade.

## Voice and mouse are one producer now: component adoption (2026-08-13)

The two-producer era above (dimensions AND interactors publishing separate
clauses into the brush) is over. Every dimension in store.ts now BINDS to the
on-screen component that speaks its column (`bindSelectionComponents`,
`aiui-viz/mosaic-selection`): a spoken `set-mag` publishes through the mag
histogram's own Interval1D — its source identity, its clients set, its brush
rectangle (moveSilent post-init; the `value` seed pre-render) — and a mouse
drag mirrors quietly back into the dimension's durable value. One clause per
bound dimension, always; the empty-intersection trap (a mouse brush AND'd
under a voice range on the same column) is structurally impossible now.
Consequences worth naming:

- **Saved views capture mouse state.** A drag lands in the dimension, so
  `save-view` snapshots it and `load-view` REDRAWS the rectangle. The
  2026-08-12 caveat ("a view cannot capture a menu or map brush") is void for
  every bound producer — which is all of them here (`magtype` gained a dim so
  the second menu is covered).
- **A brush now SURVIVES a theme flip.** MosaicView unregisters before the
  ghost-clause retraction, so the binding republishes headlessly across the
  gap and re-drives the reborn interactor (value-seeded pre-render). The
  2026-08-12 "in-flight plot brush is lost" trade above is void too.
- **The map is WYSIWYG, not exact.** `lon`/`lat` bind jointly to the
  Interval2D over projected `eq_x`/`eq_y` (transforms in store.ts:
  `degreesToEqBox` corner-samples — equator included when spanned — and
  `eqBoxToDegrees` inverts via `equalEarthInverse`, a Newton solve). A spoken
  region draws the bounding eq-box of the requested degrees and THAT box
  filters — matching what a mouse drag means, superset near poleward corners.
  Unbound (pre-render), the dims still publish exact lon/lat SQL.
- **One-sided ranges have no honest rectangle** (a half-open d3 brush doesn't
  exist), so `set-mag {lo: 7}` clears the brush visual while the `>=` clause
  filters; the inspector carries the truth.
- Two paid-for findings live in mosaic-facet.ts: a menu's native clause value
  is a SCALAR (`clausePoint`), so the mirror's loop guard must store the
  clause's shape, not tuples; and a menu's late options-query `update()`
  re-syncs from `valueFor` BEFORE our clause's emit settles on a fresh load —
  the binding re-asserts the `<select>` when its own publish echoes back.

## Category filters gray out now: the toggle's own selection (2026-08-13)

The depth-class bar renders unselected categories muted (the marimo pattern:
full bars, faded when excluded) via mosaic's `highlight` interactor — which
CANNOT ride the shared crossfilter. Verified in mosaic-core 0.28.1:
`highlight({ by })` tests rows with `selection.predicate(mark)`, and the
crossfilter resolver unconditionally drops every clause whose `clients`
contain the mark — precisely the toggle's own clause (`toggleY` publishes
`clients: plot.markSet`). Highlight over the crossfilter is a silent no-op
for the one clause it exists to render; mosaic's own examples never pair the
two. The wiring (aiui-viz `categorySelection`, whose docblock carries the
mechanism): the toggle publishes into its OWN non-cross selection
(`store.depthClassSel`), created BEFORE the brush and include-relayed into it
(`Selection.crossfilter({ include: [...] })` — construction is mosaic's one
hookup point); the chart pairs `toggleY({ as: depthClassSel })` with
`highlight({ by: depthClassSel })`; the `depthClass` dim retargets to the
origin selection, and the relay carries its clause into `brush.clauses` for
every other view, the inspector, and the signal — clients intact, so the
producing chart still self-excludes. Two traps the include relay sets:

- **The relay is one-way** (origin → crossfilter), so `brush.reset()` alone
  leaves the origin holding its clause — the chart stays grayed over an
  unfiltered page. Every whole-state clear (`clearFilters`, load-view) goes
  through `resetSelectionDimTargets`: one reset per unique dim-target
  Selection, origins included. Per-component clears resolve the origin
  through the producer registry (`clearSelectionFor`).
- **`Toggle` implements no `reset()`** (Interval1D/2D, Region, Menu, Search
  do), so an external clear leaves its internal `value` stale and the next
  click reads as a deselect. The facet mirror nulls it when the clause
  vanishes (mosaic-facet.ts `clearPointVisual`).
- **The origin must be `intersect`, not `single`** (measured live in this
  page): adoption publishes the component clause and then retracts the dim's
  headless clause — under single resolution that different-source,
  null-predicate update DISPLACED the just-published component clause from
  the origin, which went empty (chart un-grayed) while the relayed copy kept
  filtering the crossfilter. Replace-by-source is the semantics both writers
  assume; `categorySelection()` encodes it.

Per-component clearing landed with it: `clear-selection { name }` (a
dimension, or a component name — "seismos/map" clears the 2-D box WHOLE,
where clearing `lon` alone would widen that side to full extent) and the
inspector's per-row ✕, both over the same `clearSelectionFor`.
