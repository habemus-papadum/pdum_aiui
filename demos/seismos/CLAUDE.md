# demo: seismos

Earthquakes & the Gutenberg–Richter law: DuckDB-WASM + a Mosaic crossfilter
over a bundled 4 MB catalog, an Equal-Earth epicenter density map, a live
b-value fit, and a bounded agent SQL tool. A real, maintained demo — **not**
starter scenery. Read `src/NOTES.md` for the Mosaic/Solid boundary decisions.

## Run the loop

```sh
pnpm claude   # terminal 1 — Claude Code with the aiui channel + session browser
pnpm dev      # terminal 2 — this app (Vite + the intent tool)
```

## The dual shape (app + library)

- `src/main.tsx` — the standalone entry: journal chrome + `./page`.
- `src/page.tsx` — the `SitePage` the gallery shell mounts (discovered via the
  `aiui.sitePage` marker in package.json). Page-owned styles in `src/page.css`.
- `src/index.ts` — the library barrel: store surface, graph accessor, widgets,
  the pure GR math.
- `src/data/` — the catalog + border overlay, imported as `?url` Vite assets
  (NOT public/ fetches) so the data travels with the demo into any consumer's
  build, the gallery's included.

## Ground rules

- **Everything is scoped.** `seismosScope = scope("seismos")` (store.ts)
  qualifies the control surface, the durable store, and the loading cell; the
  graph key and toolkit (`window.__seismos`) carry the same slug. New
  declarations MUST thread it. See the user guide's "Composing bigger apps".
- **Keep the split.** `src/store.ts` = the durable DuckDB/Mosaic island +
  curated controls (rarely edited; the load is memoized behind `ensureLoaded`).
  `src/graph.ts` = disposable cells + agent tools. `src/ui/` = pure readers;
  Mosaic owns its own reactivity — Solid meets it only at the shared Selection
  and the histogram client's signal (NOTES.md).
- **Don't remove the integration.** The `aiui()` plugin in vite.config.ts
  stamps source locations; the locator also runs under Vitest.

Methodology docs: <https://habemus-papadum.github.io/pdum_aiui/guide/frontend-user-guide>
