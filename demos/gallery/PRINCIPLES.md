# Principles — moved to the real documentation

This file was the working draft written alongside the morphogen build. It has graduated into the
repo documentation, which is now the **single source of truth**:

- **Concepts & desiderata** — [`docs/guide/frontend-for-agents.md`](../../docs/guide/frontend-for-agents.md)
- **Design choices** (framework-designer level, with code references) —
  [`docs/guide/frontend-design-choices.md`](../../docs/guide/frontend-design-choices.md)
- **Hard-won technical details** (the paid-for findings ledger) —
  [`docs/guide/frontend-hard-won.md`](../../docs/guide/frontend-hard-won.md)

The reusable utilities described there live in `@habemus-papadum/aiui-viz`
(`packages/aiui-viz`); this package keeps only the science and the app code.

What stays useful *here* is the map — the demo's layout is the methodology in miniature:

```
src/
  sim/          morphogen's imperative WebGL island (engine, loop, shaders, cheap stats)
  analysis/     morphogen's worker pipeline (pure core + chunked/cancellable worker)
  model/        store.ts (durable roots) · graph.ts (the disposable cell graph) · data
  ui/           morphogen components — all freely hot-swappable
  pages/aztec/  the second notebook (see its NOTES.md for build findings)
  main.tsx      morphogen entry: almost nothing
```

Source/cell stamping (`data-source-loc` + `cell()` identity injection) is enabled via the
`aiuiDevOverlay({ locator: { cellFactories: ["cell"] } })` option in `vite.config.ts`; the
implementation lives in the overlay (`packages/aiui-dev-overlay/src/source-locator.ts`).

Per-build findings ledgers: `src/pages/aztec/NOTES.md` (already folded into the docs;
kept as the raw record).
