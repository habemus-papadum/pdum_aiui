# demo: morphogen

The Gray-Scott reaction–diffusion lab — the original aiui reference notebook: a
WebGL simulation island (durable canvas + engine), a cancellable worker
analysis pipeline, an observable history ring, and a regime catalog with
simulated-failure chrome. A real, maintained demo — **not** starter scenery;
edit it the way you'd edit an app you intend to keep.

## Run it

```sh
pnpm dev      # Vite; the voice dock takes OPENAI_API_KEY from the environment
```

## The dual shape (app + library)

This package is both a standalone app and a library — the demo-package
convention (root CLAUDE.md, "In-repo demo apps"):

- `src/main.tsx` — the standalone entry: the design system's stylesheet + `./page`.
- `src/page.tsx` — the `SitePage` (from `@habemus-papadum/aiui-viz`) the
  gallery shell mounts; discovered via this package.json's `aiui.sitePage`
  marker. Page-owned styles live in `src/page.css`; the shared chrome comes from
  `@habemus-papadum/aiui-design`.
- `src/index.ts` — the library barrel: store surface, graph accessor, widgets,
  pure model.

## Ground rules

- **Everything is scoped.** `morphogenScope = scope("morphogen")`
  (model/store.ts) qualifies every control, durable, cell, and action, and
  names the graph key and the agent toolkit (`window.__morphogen`). This is
  what lets the demo share one document with its siblings in the gallery.
  New declarations MUST thread it: `control({ scope: morphogenScope, … })`,
  `morphogenScope.durable(…)`, `cell(deps, compute, { scope: morphogenScope })`,
  `action({ scope: morphogenScope, … })`. See the user guide's "Composing
  bigger apps" and `packages/aiui-viz/src/scope.ts`.
- **Keep the architecture's split.** `src/model/store.ts` = durable roots +
  the curated control surface (rarely edited; a full reload). `src/model/graph.ts`
  = the disposable cell graph (`hotCellGraph`) + agent tools. `src/ui/` = pure
  readers, freely hot-swappable. `src/sim/` + `src/analysis/` = playbook
  layer 1 (pure functions + the worker), unit-tested headless.
- **Don't remove the integration.** The `aiui()` plugin in vite.config.ts
  stamps the source locations the page's `locate`/`selection`/`source` tools
  read; the same plugin (locator-only) runs under Vitest so compiler-injected
  names hold in tests.
- The shader HMR hook in store.ts recompiles GLSL in place, preserving the
  accrued field — edit `src/sim/shaders.ts` freely while a run matters.

Methodology docs: [the user guide](../../packages/aiui-viz/docs/frontend-user-guide.md).
