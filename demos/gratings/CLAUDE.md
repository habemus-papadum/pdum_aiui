# demo: gratings

The diffraction-design notebook: how stripe patterns steer and split light,
taught at the level where someone could design with it. One live bench —
phase arrows (Huygens, tip-to-tail), the N-slit grating and its far-field
orders, a six-λ spectrometer with real design readouts (R = mN, order
overlap), and the zone-plate "lens made of stripes" doing imaging and
magnification with honest chromatic behavior. Every field picture is the
scalar wave equation computed live by `@habemus-papadum/aiui-optics` (the
shared engine package, whose unit tests pin the physics claims); every dashed
overlay is the one-line design rule, drawn over the computed wave so the two
visibly agree. The sibling `demos/holograms` notebook continues the story.
A real, maintained demo — **not** starter scenery.

## Run the loop

```sh
pnpm claude   # terminal 1 — Claude Code with the aiui channel + session browser
pnpm dev      # terminal 2 — this app (Vite + the intent tool)
```

## The dual shape (app + library)

- `src/main.tsx` — standalone entry: journal chrome + `./page`.
- `src/page.tsx` — the `SitePage` the gallery shell mounts (discovered via the
  `aiui.sitePage` marker). Page-owned styles in `src/page.css`, all scoped
  under `.gratings`; shared chrome from `@habemus-papadum/aiui-journal`;
  widget layout from `@habemus-papadum/aiui-optics/widgets.css`.
- `src/card.tsx` — the landing `DemoCard`: a live two-source interference
  miniature built from the pure engine only (no store/graph).
- `src/index.ts` — the library barrel: scope, graph, App, and the pure bench
  math (`gratingOrders`, `lensImage`, …).

## Structure

- `src/model/store.ts` — the curated control surface (λ, pitch, N, angles,
  probe, zone-plate f, object position). Deliberately SHARED across sections:
  λ moved in one section moves its twins everywhere — part of the pedagogy.
- `src/model/bench.ts` — playbook layer 1: apparatus geometry, mask builders,
  the design formulas the readouts quote, and the `MapRequest` builders.
  Tested in `bench.test.ts`.
- `src/model/map.worker.ts` — thin worker-stream seam; the map computation is
  aiui-optics's `runMapRequest` (streams column chunks, macrotask yields so
  cancel works). ONE durable worker; map cells cancel superseded jobs.
- `src/model/graph.ts` — the cell graph: streaming map cells (held where
  `Worker` doesn't exist — jsdom/SSR) + inline pure cells (far fields, phasor
  arrows, readouts). Probed per-input in `graph.test.ts`.
- `src/ui/` — pure readers. `FieldMap`/`PhasorDial`/`FilmStrip` come from
  `@habemus-papadum/aiui-optics/widgets`; overlays draw in world coordinates
  (see `ui/overlays.tsx` — SVG for rays/lines, HTML dots for screen-true
  markers, because the map's aspect is anisotropic).

## Ground rules

- **Everything is scoped** under `appScope = scope("gratings")` — controls,
  durables, cells, actions, the graph key, the toolkit (`window.__gratings`).
- **Physics honesty is the product.** If a section's claim can't be computed
  live, it doesn't go on the page. The slit-arrow dial reads far-field phases
  (direction space) on purpose — a near-field point probe would add Fresnel
  curvature and blur the order-locking lesson (see the cell's docblock).
- **The engine belongs to `demos/optics`.** New physics goes there, with
  tests, and both notebooks get it; app-local math stays in `bench.ts`.
- **Don't remove the integration.** The `aiui()` plugin in vite.config.ts
  stamps source locations; the locator also runs under Vitest.

Methodology docs: <https://habemus-papadum.github.io/pdum_aiui/guide/frontend-user-guide>
