---
name: frontend-design
description: How to write reactive scientific-visualization frontends in aiui projects — SolidJS 2.0 cells, durable/disposable HMR structure, worker streaming, agent tool surfaces. Use when creating or refactoring frontend/visualization code in a project that uses @habemus-papadum/aiui-viz (or when asked to follow the aiui frontend methodology). The repo docs are the source of truth; this skill is the operational digest.
---

# aiui frontend design

**Sources of truth** (read when depth is needed; if this digest ever disagrees, trust them and
say so): `docs/guide/frontend-for-agents.md` (concepts) →
`docs/guide/frontend-design-choices.md` (design, with code refs) →
`docs/guide/frontend-hard-won.md` (gotcha ledger) →
`docs/guide/frontend-style-guide.md` (authoring conventions: page structure, TOC, plotting,
math, porcelain/plumbing). Library: `packages/aiui-viz` — plumbing on the root barrel (`cell`,
`CellView`, `workerStream`/`fromWorker`, `durable`, `agentToolkit`), porcelain on subpaths
(`…/plot` → `PlotFigure`; `…/site` → `SiteHeader`, `TocRail`, `TeX`, `colorMode` — katex/plot
are optional peers only those subpaths need). Reference apps: `packages/aiui-demo` (morphogen +
aztec notebooks).

## The structure (non-negotiable)

Split every app along the **durable/disposable** line, visible in the module layout:

- `model/store.ts` — durable roots, all owned by `durable(key, create)` (create-once,
  adopt-forever): engines, workers, canvases, history rings, and every user parameter
  (as durable signals). Rarely edited; edits here full-reload.
- `model/graph.ts` — the **disposable cell graph**, rebuilt wholesale on hot edits and published
  through a durable box signal the UI subscribes to (never import cells directly into
  components). Ends with the self-accept block: dispose old root → build → set box →
  `import.meta.hot.accept()`.
- `ui/` — components; freely hot-swapped. Adopt durable DOM islands via ref callbacks; cleanup
  must never un-parent a resource the successor may already have adopted (guard: "still mine?").
- Imperative islands (WebGL/rAF/big libs) never touch signals in their hot loop. Bridge inbound
  with `createEffect(source, handler)` pushing into methods; bridge outbound by publishing a
  small snapshot into ONE signal at a slow cadence (~4 Hz).

## Async work = cells

Every async value is a `cell(deps, compute)`: deps returning `undefined` holds; compute may
return a value, promise, or async iterable (streaming is the default — commit partials; gate
expensive consumers with `settledOnly` or `stream: "latest"`). Cancellation is supersession —
pass `ctx.signal` into fetches/workers; an explicit cancel is "set deps to undefined". Render
cell values through `<CellView of={cell}>` (loading/error/keep-last chrome + the `data-cell`
attribution stamp come free). Long computations live in workers speaking the
`workerStream` protocol: **yield a macrotask between chunks** (`setTimeout 0` — else cancel is
never delivered), stream the cheap phase early, keep the math in a pure realm-free module with
unit tests, post errors as `{type:"error"}`. Don't emit the final value as both partial and done.

## The agent surface (build it as you build features)

`agentToolkit("<page-ns>")` → register a tool and/or reporter **next to each feature**:
name+description(+`inputSchema` JSON Schema for real tools), idempotent by name. When the aiui
dev overlay is active, the toolkit auto-forwards each namespace to the channel — the session can
then drive the page remotely via the `page_tools_list` / `page_tools_call` MCP tools, no app
wiring. Always provide one bounded `report()`. Components rendering cell values *outside* CellView declare
`data-cell="<name>"` (one attribute — the only manual attribution affordance; cell names/locs
are injected at compile time by the source-locator plugin). Verify your own work through this
surface: `.tools`, `.call(name, args)`, `.report()`, `.call("locate", { selector })`.

## Solid 2.0 (beta) instant-bite gotchas

- No `onMount` (ref callbacks), no `classList` (compute class strings); `render`/`JSX` come from
  `@solidjs/web`; `<Show>` non-keyed callback children receive an *accessor*.
- Writes inside owned scopes throw in dev — internal bookkeeping signals need
  `{ ownedWrite: true }`; otherwise write from handlers or `queueMicrotask`.
- `createEffect(source, handler)`: the handler is untracked for *reads* too — consume the value
  the source computed, never re-read signals in the handler.
- Writes are batched: `set` then `get` in the same tick reads stale. Tools return the value they
  computed; when driving via `evaluate_script`, await a `setTimeout 0` before `report()`.
- A cell is callable — never put identity on `.name` (Function.name is read-only).

## HMR rules that keep live state safe

`import.meta.hot.accept(dep, cb)` only works in a *direct importer* of dep, and every import
path to a changed module needs an acceptor or the page full-reloads (sever secondary imports by
passing values through constructors). Never `optimizeDeps.include` a workspace-linked package
(lockfile-keyed cache serves it stale). Don't edit `*.worker.ts` or `store.ts` while a live run
matters — those force full reloads. Log every hot swap with what it preserved.

## Page anatomy & theming

A notebook page reads like a paper (full conventions: the style-guide doc): `section[id]`
blocks — the complete dashboard overview FIRST (everything on screen at load), then explanatory
sections re-rendering their own instances of the same widgets (double-mounting shared cells is
free and intended; durable canvases stay in the overview only), then theory (equations the page
actually demonstrates, via `TeX` from `aiui-viz/site` — never raw katex, you'd lose the
`data-tex` stamp), then experiments naming exact controls. `TocRail` + `SiteHeader` from
`aiui-viz/site`, tabs fed from one nav module with one-line descriptors, relative hrefs. Respect `prefers-color-scheme` (no toggle): tokens on `:root` (dark base + light
media query), a reactive theme signal for literal colors (charts/SVG), palettes validated per
mode against each mode's surface; sim canvases stay self-contained dark figures in both modes —
and note figure colors (canvas + its legend chips) are cross-mode *constants* while panel-chart
colors are *per-mode*: same hex in dark, they diverge in light.

## Charts

Follow the dataviz skill (validate palettes against the actual surface; fixed categorical
assignment; legends for ≥2 series). Keep imperative chart libs behind one bridge component
(`@habemus-papadum/aiui-viz/plot` for Observable Plot); d3 contributes scales to plain JSX.

## Definition of done

Typecheck + unit tests (pure logic: stats, algorithms) + lint pass; drive the app through its
own tool surface in the session browser (zero console errors, `report()` sane); prove HMR
preserves the running state for a component edit and a graph edit; screenshot the result.
