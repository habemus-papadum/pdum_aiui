# The embedding bridge — Apple's Embedding Atlas as a Mosaic citizen

`@habemus-papadum/aiui-viz/embedding` wraps the `embedding-atlas` package's
`EmbeddingViewMosaic` — a WebGL point cloud for 2-D embedding projections
(millions of points, density mode, automatic cluster labels, tooltips) — as a
first-class member of an aiui Mosaic app: same coordinator, same Selections,
same producer registry, same agent surface as a vgplot view. `demos/wine` is
the reference consumer.

## Why the component level (and not the EmbeddingAtlas app)

The `embedding-atlas` npm package ships three tiers: `EmbeddingView` (raw
arrays in, no database), `EmbeddingViewMosaic` (a Mosaic client: give it a
coordinator + table/column names, it queries DuckDB itself), and
`EmbeddingAtlas` (a complete application — its own charts, table, search, and
layout, exposing only an opaque state JSON and a flat predicate string).

We integrate at `EmbeddingViewMosaic`, the highest tier that stays *open*:
every interactive surface is a Mosaic `Selection` prop —

- `filter` — a Selection whose clauses filter the view's points (pass the
  app's crossfilter and every other widget filters the cloud);
- `rangeSelection` — the view's rectangle/lasso publishes clauses here (pass
  the same crossfilter and a lasso narrows every other view);
- `selection` / `tooltip` — point picks, Selection-or-value.

Mosaic is a *peer* of `embedding-atlas`, so the component shares the app's
`@uwdata/mosaic-core` classes — its clauses land in your Selections as plain
clauses. The full-app tier would sit in the page as a sealed appliance: none
of its internal charts could be a `selectionDim`, nothing would appear in the
producer registry, and saved views/`clear-selection`/`report()` would see only
a predicate string. Component level + our own cross-filter widgets *recreates*
the Atlas experience on aiui's terms.

## What the bridge does

```tsx
import { EmbeddingView } from "@habemus-papadum/aiui-viz/embedding";

<EmbeddingView
  coordinator={store.coordinator}
  table="wine" x="projection_x" y="projection_y"
  category="variety_cat"        // 0-indexed ints — derive them at load
  text="description" identifier="id"
  filter={store.brush}
  rangeSelection={store.brush}
  scope={appScope} name="embedding"
  viewOptions={() => ({
    config: { colorScheme: mode() },       // reactive: theme flips re-skin
    categoryColors: palette().categories,  // share with the category bar
  })}
/>
```

- **Reactive props.** One effect merges the declarative props with the
  `viewOptions` thunk and routes changes through the component's own
  `update()` — no rebuild, selections and viewport survive a theme flip.
- **Host-fitted sizing.** The component wants literal width/height; the
  bridge measures its host (ResizeObserver) and defers creation until the box
  has extent. Give the host CSS a real height.
- **Producer identity.** The component publishes *every* clause (range,
  point, tooltip) from one internal MosaicClient and installs `reset()` on it
  — the honest producer identity (replace-by-source, crossfilter
  self-exclusion via its `clients` set, visual reset through
  `Selection.reset`). The vanilla API never hands that client out, so the
  bridge captures it with a forwarding facade on the `rangeSelection` prop
  and registers it under `name` — the SelectionInspector attributes its
  clauses, and `clear-selection { name: "<scope>/<name>" }` clears the region
  with its visuals.
- **No ghost clauses.** Unlike vgplot interactors, the component retracts its
  own clauses on destroy (verified in 0.24's source) — the bridge just calls
  `destroy()`.

## Region adoption — the agent draws the lasso

A pair of interval `selectionDim`s adopts the view through
`bindSelectionComponents`, exactly like seismos' map pair:

```ts
const projx = selectionDim({ scope, kind: "interval",
  targets: [{ selection: brush, field: "projection_x", table: TABLE }] });
const projy = selectionDim({ /* …projection_y… */ });
bindSelectionComponents({ bindings: [
  { dims: [projx, projy], producer: "wine/embedding",
    to: dimsToRect, from: rectToDims },
]});
```

Under the hood this rides mosaic-facet's **self-driving producer** seam
(`AIUI_DRIVE`): the bridge installs a drive hook on the captured client, and
the binder calls it with the `to()`-mapped value (an embedding-atlas
`Rectangle`) instead of vgplot brush surgery — the component then draws the
box AND publishes the clause itself, asynchronously. Consequences the binder
handles for you, pinned by `mosaic-facet.test.ts`:

- the dimension's headless clause keeps filtering until the driven clause is
  seen landing (no filter gap; stale echoes — e.g. the component's initial
  null clause — can't wipe the dims);
- a repeated identical `set` (which the component's own deep-equality guard
  swallows without an echo) doesn't wedge the mirror;
- a mouse rectangle mirrors into the dims exactly; a freehand **lasso**
  mirrors as its *bounding box* while the published clause keeps the true
  polygon — dims and saved views carry the box, the filter stays honest.

## Traps (paid for once already)

- **Category column must be 0-indexed small integers.** The component casts
  `category` to `UTINYINT`; strings or NULLs are a query error. Derive a
  `CASE … THEN 0/1/2 …` column at load (wine's `classifySql`).
- **Peer resolution:** `embedding-atlas` declares non-optional peers on
  `@uwdata/mosaic-spec` and `@uwdata/vgplot`; with pnpm auto-install-peers
  those resolve to the *newest* release, which can be broken upstream
  (mosaic-spec 0.30.0 demanded an unpublished vgplot ^0.30.0). Pin both at
  the app's mosaic line in the consumer's dependencies.
- **The host must have extent** before the component exists — a 0×0 mount
  falls back to the component's 800×800 default. The bridge defers creation,
  so an always-`display:none` host simply never mounts one.
- **Exclude `embedding-atlas` from Vite's dep optimizer** —
  `optimizeDeps: { exclude: ["embedding-atlas"] }` in the consuming app's
  vite config. The package spawns its workers with
  `new Worker(new URL("./clustering.worker.js", import.meta.url))`;
  pre-bundling relocates the importing module into `.vite/deps/` where the
  worker files don't exist, and the only symptom is cluster labels hanging
  forever at "Generating labels…". (This is a node_modules dep — the
  never-`optimizeDeps.include`-a-WORKSPACE-package rule is unrelated.)
- **The point cloud needs WebGPU.** Without it the component still mounts,
  runs its queries, and publishes/receives clauses — but the canvas shows
  "WebGPU is unavailable" instead of points. Headless verification needs
  `--enable-unsafe-webgpu` (macOS headless Chromium then renders via Metal);
  forcing `--use-angle=swiftshader` kills the adapter.
- **Occluded windows freeze the whole Mosaic world.** Chrome pauses the
  rendering pipeline (rAF, ResizeObserver delivery, screenshots) for a fully
  occluded window while `document.visibilityState` still reads "visible" —
  Mosaic's coordinator scheduling rides that pipeline, so views, menus, and
  clients all stall until the window is actually seen. The bridge measures
  its host directly at mount (layout still computes under occlusion) so at
  least the component exists; when driving a page from a session browser
  whose window is buried, verify in a headless instance instead.
- **Point clauses + the preagg index:** like every Mosaic app here, a custom
  stats client over the crossfilter wants `filterStable = false`, or a
  variety/country (point) clause silently doesn't filter it
  (frontend-hard-won.md, Mosaic section).

See also: [duckdb-mosaic.md](./duckdb-mosaic.md) (the coordinator/DuckDB
plumbing this rides), the `selectionDim`/facet-adoption docblocks in
`src/mosaic-selection.ts` / `src/mosaic-facet.ts`, and `demos/wine`.
