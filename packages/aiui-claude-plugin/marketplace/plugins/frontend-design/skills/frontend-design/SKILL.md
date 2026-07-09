---
name: frontend-design
description: How to write reactive scientific-visualization frontends in aiui projects — the four-layer playbook (pure functions → cells → components → application), SolidJS 2.0 cells, durable/disposable HMR structure, worker streaming, agent tool surfaces. Use when creating, PLANNING, or refactoring frontend/visualization code in a project that uses @habemus-papadum/aiui-viz (or when asked to follow the aiui frontend methodology). The repo docs are the source of truth; this skill is the operational digest.
---

# aiui frontend design

**Sources of truth** (read when depth is needed; if this digest ever disagrees, trust them and
say so): [frontend-playbook.md](../../../../../../../docs/guide/frontend-playbook.md)
(the BUILD ORDER: pure functions → cells → components → application, a definition of done per
layer, vertical slices — follow it when creating or extending an app) →
[frontend-user-guide.md](../../../../../../../docs/guide/frontend-user-guide.md)
(the progressive how-to — cells, deps tracking and its out-of-sync bug, testing, streaming,
cancellation, workers, layout) →
[frontend-for-agents.md](../../../../../../../docs/guide/frontend-for-agents.md)
(concepts) →
[frontend-design-choices.md](../../../../../../../docs/guide/frontend-design-choices.md)
(design, with code refs) →
[frontend-hard-won.md](../../../../../../../docs/guide/frontend-hard-won.md) (gotcha ledger —
includes the Mosaic/DuckDB-WASM section) →
[frontend-style-guide.md](../../../../../../../docs/guide/frontend-style-guide.md) (authoring
conventions: page structure, TOC, plotting, math, porcelain/plumbing). (In the pdum_aiui repo
these links are the live guide docs; in a packaged install they point at copies bundled with
this skill. Same content published at https://habemus-papadum.github.io/pdum_aiui/.) And
always: the **installed package's own `.d.ts`/docblocks** — every export documents its
contract; resolve `@habemus-papadum/aiui-viz` in node_modules and read the module headers.

Library surface (`@habemus-papadum/aiui-viz`): plumbing on the root barrel (`cell`,
`settledOnly`, `CellView`, `workerStream`/`fromWorker`, `durable`/`durableSignal`,
`hotCellGraph`, `agentToolkit`/`registerStandardTools`); `…/testing` → the cell-test harness
(`cellHarness`, `whenReady`, `whenState`, `recordCommits`) — use it, never hand-roll
createRoot/tick plumbing in app tests; porcelain on subpaths, one per
heavyweight optional peer — `…/plot` → `PlotFigure` (Observable Plot); `…/mosaic` →
`MosaicView` (Mosaic/vgplot bridge: coordinator + reactive directive-list spec in, connected
Plot out, marks disconnected on dispose); `…/duckdb` → `instantiateDuckDB` +
`fetchWithProgress` (DuckDB-WASM from app-bundled `?url` assets — the four asset imports stay
in YOUR app, see the module docblock); `…/site` → `SiteHeader`, `TocRail`, `TeX`, `colorMode`;
`…/modal` → the framework-free modal interaction kit. Reference apps: `demos/gallery` —
morphogen + aztec notebooks (cells/workers/Plot), **seismos** (the Mosaic + DuckDB reference:
Parquet → DuckDB-WASM → crossfilter Selection → coordinated vgplot views; its NOTES.md is the
stack's field ledger).

## The playbook: the default order of work (and the default shape of a plan)

When building **from scratch — or anything bigger than a one-line tweak — follow the
[playbook](../../../../../../../docs/guide/frontend-playbook.md) unless you can state a concrete
reason not to.** Four layers, each with its own verification, rigor front-loaded:

1. **Pure functions** — domain math, realm-free (no solid-js, no window, no import.meta.env);
   exhaustive unit tests, benchmarks for anything possibly slow. Library-shaped, not app-shaped.
2. **Cells** — the *chosen* computation boundaries where reality (time, failure, cancellation,
   streaming) enters; NOT 1:1 with the pure functions. Headless tests via `aiui-viz/testing` —
   one per-input probe per cell. The `.worker.ts` file is a thin protocol seam; the math stays
   in layer 1.
3. **Components** — pure readers: cells in (via `graph()`), DOM out, through `CellView`.
   Behavioral jsdom tests now; the HUMAN is the visual tester until the app has earned
   screenshot automation.
4. **Application** — page anatomy, modal keymaps (pure tables, tested), multi-page progression;
   done when the whole app is drivable through its own tool surface.

Not a waterfall: get one thin slice through all four layers on screen early, then deepen — the
human steers by looking at the running app. But within every slice and every feature, descend in
this order, and **when asked to produce a PLAN for a visualization, structure the plan as these
four layers with each layer's definition of done** — a plan organized any other way needs a
stated justification.

**Starting in a fresh scaffold?** The starter ships placeholder scenery (the rose) fenced with
`<aiui-scenery>` markers, staged as the playbook in miniature (`rose.ts`+test = layer 1,
`scenery.ts`+test = layer 2). If the user wants their own app rather than an edit of the rose,
**reset to a blank canvas first** via the scaffold CLAUDE.md's § *Reset to a blank canvas* —
three mechanical deletion steps under `src/`, no code reasoning (cheap-model work; CI runs the
same procedure). Never treat un-reset scenery as the user's code.

## The structure (non-negotiable)

Split every app along the **durable/disposable** line, visible in the module layout (this is
the playbook's layer 2 made physical; `ui/` is layers 3–4):

- `model/store.ts` — durable roots: user parameters via `durableSignal(key, initial)`,
  everything else (engines, workers, canvases, history rings) via `durable(key, create)`
  (create-once, adopt-forever). Rarely edited; edits here full-reload.
- `model/graph.ts` — the **disposable cell graph**, one
  `export const graph = hotCellGraph<AppGraph>("app", build, import.meta.hot)` call: it owns the
  durable box, the dispose-and-rebuild on hot edits, and the self-accept. Do NOT hand-roll that
  ritual — it was extracted precisely because hand-rolled copies drifted. `import.meta.hot` must
  be written at the call site (it is bound to the calling module; a library cannot read it), and
  the returned accessor is non-optional: components read `graph().cellName` with no `<Show>`
  guard, never a cell imported directly.
- `ui/` — components; freely hot-swapped. Adopt durable DOM islands via ref callbacks; cleanup
  must never un-parent a resource the successor may already have adopted (guard: "still mine?").
- Imperative islands (WebGL/rAF/big libs) never touch signals in their hot loop. Bridge inbound
  with `createEffect(source, handler)` pushing into methods; bridge outbound by publishing a
  small snapshot into ONE signal at a slow cadence (~4 Hz).

## Async work = cells (playbook layer 2)

Every async value is a `cell(deps, compute)`: deps returning `undefined`/`null`/`false` holds
(so a boolean dep must be boxed, `() => ({ enabled: flag.get() })`); compute may return a value,
promise, or async iterable (streaming is the default — commit partials; gate expensive consumers
with `settledOnly` or `stream: "latest"` — both pinned by unit tests in aiui-viz's
`cell.test.ts`). **Everything compute uses must arrive through the deps bundle** — a signal read
inside compute after the first `await` is untracked, and the cell goes silently stale (the
out-of-sync bug; write the unit test that moves each input). Cancellation is supersession — pass
`ctx.signal` into fetches/workers; an explicit cancel is "set deps to undefined", after which the
cell reads state `held` (value in hand, nothing running — CellView shows it quiet, not as
loading; `refreshing` means a new value IS coming). Render cell values through
`<CellView of={cell}>` (loading/error/keep-last chrome + the `data-cell` / `data-cell-loc` /
`data-cell-state` attribution stamps come free). Long computations live in workers speaking the
`workerStream` protocol: **yield a macrotask between chunks** (`setTimeout 0` — else cancel is
never delivered), stream the cheap phase early, keep the math in a pure realm-free module with
unit tests, post errors as `{type:"error"}`. Don't emit the final value as both partial and done.

## The agent surface (build it as you build features)

`agentToolkit("<page-ns>")`, then `registerStandardTools(kit)` first — it provides `locate`
(element → source/cell stamps) and the `cells` attribution reporter, so never hand-write those —
then register a tool and/or reporter **next to each feature**:
name+description(+`inputSchema` JSON Schema for real tools), idempotent by name. When the aiui
dev overlay is active, the toolkit auto-forwards each namespace to the channel — the session can
then drive the page remotely via the `page_tools_list` / `page_tools_call` MCP tools, no app
wiring. Always provide one bounded `report()`. Components rendering cell values *outside* CellView declare
`data-cell="<name>"` — one attribute, a *name*, and it is the ONLY attribution attribute ever
written by hand. **NEVER hand-write `data-source-loc` or `data-cell-loc`** — locations are
compiler output (the source-locator plugin, `aiuiDevOverlay({ locator })`); a typed-in
`file:line:col` lies as soon as the file is edited and the resolvers cannot detect it. An agent
did this once instead of enabling the plugin, and the confident-but-wrong resolutions it caused
must not be repeated: if stamps are missing, fix `vite.config.ts`, never the markup (full
contract: [attribution.md](../../../../../../../docs/guide/attribution.md)). Verify your own work through this
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
assignment; legends for ≥2 series). Keep imperative chart libs behind one bridge component;
d3 contributes scales to plain JSX. Division of labor: **Plot** (`aiui-viz/plot`) for a chart
*of a cell's value*; **Mosaic** (`aiui-viz/mosaic` + `aiui-viz/duckdb`) when the data lives in
a database **table** and views coordinate through Selections (brushing filters, aggregation
pushed down to DuckDB). Mosaic durables: the DuckDB instance, coordinator, and Selections live
in the store; specs are reactive thunks (theme reads rebuild views against the surviving
coordinator). Pin `@duckdb/duckdb-wasm` to the exact version `@uwdata/mosaic-core` uses (one
deduped copy), and read the hard-won doc's Mosaic section before writing a custom MosaicClient.

## The library is young — treat it as improvable, not frozen

`@habemus-papadum/aiui-viz` is an early library in a young project. Before leaning on one of its
exports for something load-bearing, **check that the behavior you need is pinned by a unit test**
(`packages/aiui-viz/src/*.test.ts*` — `cell.test.ts` covers the cell semantics); if it isn't,
add the test rather than assuming. When app code needs a pattern the library almost provides —
or you find yourself writing the same helper in a second app — the right move is usually to add
the abstraction to aiui-viz with tests and docblocks, then use it, leaving the app simpler.
That is how `hotCellGraph`, `durableSignal`, and `registerStandardTools` came to exist: each was
boilerplate copy-pasted into every app until it was extracted. Do not re-introduce that pattern
by working around the library in app code, and do not treat its current surface as complete.

## Definition of done

Each playbook layer has its own done (see the playbook section above); the whole change is done
when: typecheck + unit tests + lint pass. Tests mean two layers: pure logic (stats, algorithms,
worker math in its realm-free module — playbook layer 1) AND the cell graph headless via `aiui-viz/testing` —
`cellHarness(build)`, then move **each** dependency and `await whenReady(cell)` (the harness
absorbs write batching and owners); streaming cells assert via `recordCommits`, cancellation via
`whenState(cell, "held")`. The per-input probe is the instrument that catches an undeclared
dependency. Then drive the app through its own tool surface in the session browser (zero console
errors, `report()` sane); prove HMR preserves the running state for a component edit and a graph
edit; screenshot the result.
