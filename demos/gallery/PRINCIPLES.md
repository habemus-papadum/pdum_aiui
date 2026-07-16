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
  model/        store.ts (durable roots + controls) · graph.ts (the disposable cell graph)
  ui/           morphogen components — all freely hot-swappable
  pages/        one directory per notebook (morphogen/ aztec/ seismos/ — each a page module)
  site/         the SPA shell's seams: router.ts (pushState + link interception),
                pages.ts (route → lazy page module, pause-not-destroy lifecycle), nav.ts
  main.tsx      the shell: SiteHeader + route swapping; almost nothing else
```

The gallery is a **single-document SPA** (it began as one Vite entry per notebook — "Level 1" —
and moved to client-side routing so an open intent turn survives switching pages; see
`docs/proposals/spa-navigation-and-turn-continuity.md`). Each notebook is still a self-contained
module tree, lazily imported and code-split; leaving a route parks its rAF loops and disposes its
components while every durable survives for the return visit.

Source/cell/control stamping (`data-source-loc` + `cell()`/`control()`/`action()` identity
injection) is enabled via the `aiui()` plugin in `vite.config.ts`; the implementation lives in
`packages/aiui-source-processor/src/source-locator.ts`.

Per-build findings ledgers: `src/pages/aztec/NOTES.md` (already folded into the docs;
kept as the raw record).
