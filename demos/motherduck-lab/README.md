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
  with the MotherDuck extension attached; Mosaic's `wasmConnector` and aiui-viz's
  `duckdbRunner` (the agent's `sql`/`schema` tools) ride it unchanged.
- **Qualified names.** The histograms read `from([catalog, schema, table])` — the array form
  Mosaic renders as `"c"."s"."t"` — so a cloud share's table is a Mosaic source directly.
- **Local beside cloud.** Materialize a sample into the tab's `memory` catalog and ask a hybrid
  question (cloud rows inside the sample's range: the small side goes up, two numbers come down).
- **Rebuild.** The engine's terminate + create with the source's current token: the local sample
  is gone, the cloud tables are not, the coordinator and the tools follow the new generation.

```sh
aiui keys set motherduck      # once: paste a read-scaling token
pnpm dev                      # then open the page; pick a table and a numeric column
```

Agent tools install at `window.__motherduck-lab`: the standard set, `sql`/`schema`, and
`pick-table`, `pick-column`, `materialize`, `rebuild-engine`.
