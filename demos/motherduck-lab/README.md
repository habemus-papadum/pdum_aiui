# motherduck-lab

An in-repo **lab** for the in-tab MotherDuck engine — deliberately NOT a gallery page (no
`aiui.sitePage` marker): it needs a MotherDuck token, and the public gallery has none.

What it exercises, end to end, in one page:

- **The dev key.** `aiui({ devKeys: ["motherduck"] })` seeds the page with
  `MOTHERDUCK_BROWSER_TOKEN` under `vite serve` only — a READ-SCALING token of your own
  MotherDuck user, never the admin token. Store it once: `aiui keys set motherduck` (or export it
  in a source checkout). Mint one from the MotherDuck UI (Settings → Access Tokens, type
  read-scaling) or the REST API.
- **Self-hosted wasm.** `duckdbAssets: true` publishes the installed duckdb-wasm binaries at
  the MotherDuck layout (`/duckdb-wasm-assets/<version>/…`) from this origin; the engine loads
  them from there, not from a CDN.
- **One engine, the stock connector.** `@motherduck/wasm-client` boots a stock `AsyncDuckDB`
  with the MotherDuck extension attached. Mosaic uses its stock `wasmConnector`;
  agent `sql`/`schema` tools use `motherDuckRunner` over the client's pending-query
  protocol. `MD_ALL_DATABASES()` through a raw blocking connection can wedge the engine.
- **Qualified names.** A local view aliases each cloud table; histograms read
  `from(viewName)`. The array form of `from` describes multiple sources, not a
  catalog/schema/table path.
- **Local beside cloud.** Materialize a sample into the tab's `memory` catalog and ask a hybrid
  question (cloud rows inside the sample's range: the small side goes up, two numbers come down).
- **Rebuild.** The engine's terminate + create with the source's current token: the local sample
  is gone, the cloud tables are not, the coordinator and the tools follow the new generation.
- **The cross-filter, and its view in the tab's catalog.** The brush is aiui-viz's routed
  `crossfilter()`; the `schema` tool lists its filtered twin of the bridged view as
  `memory.crossfilter.<view>` (`viewCatalog: "memory"` — a cloud database never receives
  DDL), created through the client's own connection and created again after a rebuild
  (`viewEpoch`: the engine generation).

```sh
aiui keys set motherduck      # once: paste a read-scaling token (pbpaste | aiui keys set motherduck)
pnpm dev                      # then open the page; pick a table and a numeric column
```

**Attach mode.** The page URL decides how the engine attaches, once per load (a mode is fixed
by the first connect): `/?database=my_db` is **single mode** on that one database you own —
MotherDuck's recommendation for apps and service accounts; the session touches no saved
workspace and sees nothing else, so the lab attaches the public `sample_data` share for
something to look at. No parameter is **workspace mode**: every database saved in your
workspace, the personal default — a busy account attaches dozens. Either way the tab's own
`memory` catalog is made current on every connection (bridge views and the local sample are
unqualified; a bare name never resolves across catalogs), and after a table is picked the
`schema` tool lists only `memory` beside the picked table's database.

Agent tools install at `window.__motherduck-lab`: the standard set, `cross-filter` /
`reset-cross-filters` (no dimension is declared — the columns are picked at run time — so the
tool clears by component, `first` and `second`), `sql`/`schema`, and `pick-table`,
`pick-column`, `materialize`, `rebuild-engine`.
