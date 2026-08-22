# demo: wine

Wine reviews × **Embedding Atlas**: ~120k WineEnthusiast tasting notes as TWO coordinated maps
— the embedding map (Apple's `EmbeddingViewMosaic` behind `@habemus-papadum/aiui-viz/embedding`)
and an Equal-Earth **world map** (the seismos pattern) — cross-filtered with Mosaic against
critic score, price, variety, and country. This is the reference consumer of the embedding
bridge — the wiring lives in `src/model/store.ts` and is documented in
`packages/aiui-viz/docs/embedding-view.md`. A real, maintained demo — **not** starter scenery.

**Geocoding:** `src/data/provinces.json` is a curated (country, province) → lat/lon lookup for
all 478 pairs in the dataset — Natural Earth 10m admin-1 centroids (public domain) where the
province is an administrative unit, hand-placed centroids for wine regions (Bordeaux, Kamptal,
Colchagua…), country fallbacks for the tail; 97.5% of reviews land at region precision. Rows
get a deterministic hash-jitter (±0.35° lat, ±0.45° lon — `geoSql` in `src/model/data.ts`) so
provinces read as clouds, and Equal-Earth eq_x/eq_y are baked in at load (`src/model/geo.ts`
is the pure JS mirror). If the dataset revision ever changes, regenerate the lookup (match
NE admin-1 by normalized name per country, hand-fill misses, country-centroid the rest).

## Run the loop

```sh
pnpm claude   # terminal 1 — Claude Code with the aiui channel + session browser
pnpm dev      # terminal 2 — this app (Vite + the intent tool)
```

## The data (fetched, not vendored)

Two parquet files (~64 MB) are fetched at runtime and kept in the Cache API: the HuggingFace
`spawn99/wine-reviews` parquet and Apple's precomputed embedding projection, joined by a
deterministic row id — the SQL in `src/model/data.ts` reproduces Apple's own demo recipe
byte for byte (the join breaks if the dedup/ordering drifts). First visit downloads; reloads
are instant.

## Ground rules

- **Everything is scoped.** `appScope = scope("wine")` (store.ts) qualifies every control,
  durable, cell, action, and the toolkit (`window.__wine`). New declarations MUST thread it.
- **Keep the split.** `src/model/store.ts` = the durable DuckDB/Mosaic island: coordinator,
  crossfilter brush, the variety origin (`categorySelection`), the six `selectionDim`s, and
  the component bindings — including the region pair `[projx, projy] → "wine/embedding"` that
  adopts the embedding view (agent `set-projx`/`set-projy` draws the on-map box; a mouse lasso
  mirrors its bounding box back). `src/model/graph.ts` = disposable cells + agent tools.
  `src/ui/` = pure readers.
- **The embedding view is a producer like any plot.** Its `filter` and `rangeSelection` are
  the shared brush; its `name="embedding"` prop is what the region binding, the inspector,
  and `clear-selection` key on. Don't bypass the bridge to talk to `embedding-atlas` directly.
- **Don't remove the integration.** The `aiui()` plugin in vite.config.ts stamps source
  locations; the locator also runs under Vitest.

Methodology docs: <https://habemus-papadum.github.io/pdum_aiui/guide/frontend-user-guide>
