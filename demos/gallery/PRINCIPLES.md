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

What stays useful *here* is the map. The notebooks now live as their own demo packages
(the 2026-07-22 restructure — root `CLAUDE.md`, "In-repo demo apps"), each with the layout the
methodology calls for:

```
demos/
  morphogen/src/   sim/ (the WebGL island) · analysis/ (the worker pipeline) ·
                   model/ (store.ts durable roots + controls · graph.ts the disposable graph) · ui/
  aztec/src/       shuffle math + worker · store.ts · graph.ts · ui/
  seismos/src/     the DuckDB/Mosaic island (store.ts) · gr.ts pure math · graph.ts · ui/
  circle/src/      the pencil surface (model/store.ts) · model/circle.ts pure fits · ui/
  journal/src/     the shared dark-journal identity: theme.ts + styles.css
  gallery/src/
    site/          the SPA shell's seams: registry.ts (← virtual:demo-pages, the discovery
                   plugin's output), router.ts (pushState + link interception),
                   pages.ts (route → lazy page, pause-not-destroy), nav.ts
    main.tsx       the shell: SiteHeader + route swapping; almost nothing else
```

The gallery is a **single-document SPA** (it began as one Vite entry per notebook — "Level 1" —
and moved to client-side routing so an open intent turn survives switching pages; see
`docs/proposals/spa-navigation-and-turn-continuity.md`). Each notebook is a self-contained
package, discovered through its `aiui.sitePage` marker (demo-discovery.ts), lazily imported and
code-split; leaving a route parks its rAF loops and disposes its components while every durable
survives for the return visit — and every demo also runs standalone from its own directory.

Source/cell/control stamping (`data-source-loc` + `cell()`/`control()`/`action()` identity
injection) is enabled via the `aiui()` plugin in each package's `vite.config.ts`; the
implementation lives in `packages/aiui-source-processor/src/source-locator.ts`.

Per-build findings ledgers: `demos/aztec/src/NOTES.md` and `demos/seismos/src/NOTES.md` (already
folded into the docs; kept as the raw records).
