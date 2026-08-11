---
name: aiui-architecture
description: How an aiui app is architected — the four-layer playbook (pure functions → cells → components → application), SolidJS 2.0 cells, durable/disposable HMR structure, scoped identity, worker streaming, agent tool surfaces, site pages and cards. Use when creating, PLANNING, or refactoring frontend/visualization code in a project that uses @habemus-papadum/aiui-viz (or when asked to follow the aiui frontend methodology). The repo docs are the source of truth; this skill is the operational digest.
---

# aiui architecture

**Sources of truth** (read when depth is needed; if this digest ever disagrees, trust them and
say so): [frontend-playbook.md](../../../../../../../packages/aiui-viz/docs/frontend-playbook.md)
(the BUILD ORDER: pure functions → cells → components → application, a definition of done per
layer, vertical slices — follow it when creating or extending an app) →
[frontend-user-guide.md](../../../../../../../packages/aiui-viz/docs/frontend-user-guide.md)
(the progressive how-to — cells, deps tracking and its out-of-sync bug, testing, streaming,
cancellation, workers, layout) →
[frontend-for-agents.md](../../../../../../../docs/guide/frontend-for-agents.md)
(concepts) →
[frontend-design-choices.md](../../../../../../../packages/aiui-viz/docs/frontend-design-choices.md)
(design, with code refs) →
[frontend-hard-won.md](../../../../../../../packages/aiui-viz/docs/frontend-hard-won.md) (gotcha ledger —
includes the Mosaic/DuckDB-WASM section) →
[frontend-style-guide.md](../../../../../../../packages/aiui-viz/docs/frontend-style-guide.md) (authoring
conventions: page structure, TOC, plotting, math, porcelain/plumbing). (In the pdum_aiui repo
these links are the live docs; in a packaged install they point at copies bundled with
this skill. Same content published at https://habemus-papadum.github.io/pdum_aiui/.) And
always: the **installed package's own `.d.ts`/docblocks** — every export documents its
contract; resolve `@habemus-papadum/aiui-viz` in node_modules and read the module headers.

Library surface (`@habemus-papadum/aiui-viz`): plumbing on the root barrel (`cell`,
`settledOnly`, `CellView`, **`control`/`action`** (the declared control surface — names, locs,
and descriptions injected by the aiui compiler), `scope` (identity — every app declares one),
`ControlSlider`/`ControlToggle`/`Dropdown` (widgets that read bounds from the declaration),
`workerStream`/`fromWorker`, `durable`/`durableSignal`, `hotCellGraph`, **`PageBoundary`**
(the mount-seam error boundary), **`bridgeEffect`** (the hardened crossing into imperative
systems), **`throttled`** (the outbound valve), `adopt`/`durableCanvas` (durable-DOM
adoption), `agentToolkit`/`registerStandardTools`, **`SitePage`/`DemoCard`/`setSitePageActive`**
(the site contract — section below), `solidModeEngine`); `…/testing` → the cell-test harness
(`cellHarness`, `whenReady`, `whenState`, `recordCommits`, `resetControlSurface`) — use it,
never hand-roll createRoot/tick plumbing in app tests; porcelain on subpaths, one per
heavyweight optional peer — `…/plot` → `PlotFigure` (Observable Plot); `…/mosaic` →
`MosaicView` (Mosaic/vgplot bridge: coordinator + reactive directive-list spec in, connected
Plot out, marks disconnected on dispose); `…/duckdb` → `instantiateDuckDB` +
`fetchWithProgress` (DuckDB-WASM from app-bundled `?url` assets — the four asset imports stay
in YOUR app, see the module docblock); `…/site` → `SiteNav` (left sidebar, collapsing to a
top bar + drawer on a phone), `TocRail`, `TeX`, `colorMode`; `…/modal` → the framework-free
modal interaction kit + mode-engine core (`createModeEngine`, `createClaims`, the region
constructors `ladder`/`toggle`/`choice`, `barModel`, `installKeys`/`resolveKey`,
`LiveDiffText`/`wordDiff`; the Solid adapter `solidModeEngine` is on the root barrel — see
the mode-engine section below).

The compiler/locator is its own package, **`@habemus-papadum/aiui-source-processor`**: in
`vite.config.ts`, `plugins: [aiui(), solid()]` (default export; `aiui()` MUST precede
`solid()` — its `pre` Babel pass stamps JSX before vite-plugin-solid compiles each element
into an opaque template); in `vitest.config.ts`, `aiui({ locator: true })` and no solid().
It does two jobs only — JSX source-locator stamps (dev-serve) and `cell()`/`control()`
identity injection (every mode, production included) — plus an opt-in
`devKeys: ["openai"]` for dev-serve-only vendor-key injection; it deliberately does NOT
inject ports, dial sockets, or mount UI. (The old `aiuiDevOverlay` plugin is retired.)

Reference apps: **`demos/walkthrough`** (the playbook executed in order on 1-D diffusion,
every layer left standing as its own page — read its WALKTHROUGH.md when unsure what a layer
should look like); **`demos/seismos`** (the Mosaic + DuckDB reference: Parquet → DuckDB-WASM →
crossfilter Selection → coordinated vgplot views; its `src/NOTES.md` is the stack's field
ledger); `demos/gears` (pure SVG geometry, page CSS scoped under a root class);
`demos/gratings` + `demos/holograms` over `demos/optics` (worker-streamed 2-D wave maps,
WebGL field islands, physics pinned by the engine's own unit tests); `demos/circle` (the
pencil demo — `PencilSurface` from `@habemus-papadum/aiui-pencil` — and the 600px phone
case); `demos/twins` + `demos/oscillator` (slices and scopes); and `demos/gallery`, the site
shell that DISCOVERS the others (it depends on none of them — section below).

## The playbook: the default order of work (and the default shape of a plan)

When building **from scratch — or anything bigger than a one-line tweak — follow the
[playbook](../../../../../../../packages/aiui-viz/docs/frontend-playbook.md) unless you can state a concrete
reason not to.** Four layers, each with its own verification, rigor front-loaded:

1. **Pure functions** — domain math, realm-free (no solid-js, no window, no import.meta.env);
   exhaustive unit tests, benchmarks for anything possibly slow. Library-shaped, not app-shaped.
2. **Controls + cells** — the layer OPENS by declaring the control surface (`control()` per
   user-movable parameter, `action()` per verb — with real doc comments; the compiler lifts them
   as descriptions), then the *chosen* computation boundaries where reality (time, failure,
   cancellation, streaming) enters; NOT 1:1 with the pure functions. Headless tests via
   `aiui-viz/testing` — one per-input probe per cell, `resetControlSurface` in afterEach. The
   `.worker.ts` file is a thin protocol seam; the math stays in layer 1.
3. **Components** — pure readers: cells in (via `graph()`), DOM out, through `CellView`.
   Behavioral jsdom tests now; the HUMAN is the visual tester until the app has earned
   screenshot automation.
4. **Application** — page anatomy, modal keymaps (pure tables, tested; modal STATE composes
   through the mode engine — section below), and the site contract: the app as a `SitePage`
   plus a `DemoCard`, routed under one document (section below); done when the whole app is
   drivable through its own tool surface.

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

- `model/store.ts` — the app's scope, durable roots, AND the control surface. It opens with
  `export const appScope = scope("<slug>")`, and every declaration threads it: user-movable
  parameters via `control({ scope: appScope, value, min?, max?, step?, unit?, options? })`
  with a doc comment (constraints declared ONCE here validate every write — widget, keyboard,
  and agent alike; never re-state min/max in JSX), internal state via
  `appScope.durableSignal(key, initial)`, everything else (engines, workers, canvases,
  history rings) via `appScope.durable(key, create)` (create-once, adopt-forever). **Never
  declare an unscoped control/cell/action** — scoping from birth is what lets any two aiui
  apps share one document (the gallery mounts them all). The surface is curated: a knob is a
  `control`, internals stay plain. Rarely edited; edits here full-reload.
- `model/graph.ts` — the **disposable cell graph**, one
  `export const graph = hotCellGraph(appScope.name, build, import.meta.hot)` call (then
  `export type AppGraph = ReturnType<typeof graph>` — infer, don't hand-declare): it owns the
  durable box, the dispose-and-rebuild on hot edits, and the self-accept. Do NOT hand-roll that
  ritual — it was extracted precisely because hand-rolled copies drifted. `import.meta.hot` must
  be written at the call site (it is bound to the calling module; a library cannot read it), and
  the returned accessor is non-optional: components read `graph().cellName` with no `<Show>`
  guard, never a cell imported directly.
- `ui/` — components; freely hot-swapped. Adopt durable DOM islands via `adopt`/`durableCanvas`
  (ref callbacks with the "still mine?" guard — cleanup must never un-parent a resource the
  successor may already have adopted).
- **The mount seam wears `PageBoundary`** (`main.tsx` wraps the app in it; so does every
  landing-card preview). In Solid 2.0 an uncaught effect throw PERMANENTLY HALTS the whole
  document's reactive system — the boundary is the only thing standing between one bad effect
  and a dead page.
- Imperative islands (WebGL/rAF/big libs) never touch signals in their hot loop. Bridge inbound
  with **`bridgeEffect`** — never a bare `createEffect` handler: a sync throw in a plain
  handler halts the reactive graph, and durable `hotCellGraph` roots OUTLIVE any page mount,
  so no PageBoundary can contain them. `bridgeEffect` hardens the crossing and records
  failures into the bridge registry, surfaced in `report()`'s `bridges` section. Bridge
  outbound with **`throttled`** — at most N Hz commits, latest wins, the last value always
  lands.

## Async work = cells (playbook layer 2)

Every async value is a `cell(deps, compute)`: deps returning `undefined`/`null`/`false` holds
(so a boolean dep must be boxed, `() => ({ enabled: flag.get() })`); compute may return a value,
promise, or async iterable (streaming is the default — commit partials; gate expensive consumers
with `settledOnly` or `stream: "latest"` — both pinned by unit tests in aiui-viz's
`cell.test.ts`). **Everything compute uses must arrive through the deps bundle** — a signal read
inside compute after the first `await` is untracked, and the cell goes silently stale (the
out-of-sync bug; write the unit test that moves each input). Cancellation is supersession — pass
`ctx.signal` into fetches/workers; an explicit cancel is "set deps to undefined". The full state
union is `unresolved · pending · streaming · refreshing · held · ready · errored`: `held` means
value in hand, nothing running (CellView shows it quiet, not as loading); `refreshing` means a
new value IS coming. One `stream: "latest"` caveat (probed on beta.32): while a downstream
consumer is pending on the cell, in-flight writes stage into the pending question's
transaction, so `latest` coalesces to the settle value for every reader — partials stream
per-yield only when no consumer is pending. Render cell values through
`<CellView of={cell}>` (loading/error/keep-last chrome + the `data-cell` / `data-cell-loc` /
`data-cell-state` attribution stamps come free). Long computations live in workers speaking the
`workerStream` protocol: **yield a macrotask between chunks** (`setTimeout 0` — else cancel is
never delivered), stream the cheap phase early, keep the math in a pure realm-free module with
unit tests, post errors as `{type:"error"}`. Don't emit the final value as both partial and
done. `fromWorker` accepts a `Worker` OR a `() => Worker` accessor — pass the accessor so a
durable, HMR-adopted worker instance resolves lazily.

## The agent surface (build it as you build features)

**Declaring IS exposing.** `agentToolkit(appScope.name)`, then `registerStandardTools(kit)` —
it derives the whole standard surface from the declarations: `report` (`brief`/`full` —
controls, cells, actions, bridge failures, and the live control→cell dependency edges), `set`
(validated write; returns what was actually written, never a re-read), `locate` (element →
source/cell stamps), and **one real named tool per registered `action()`** (kit-relative
names: `testapp/reseed` surfaces as `reseed`; a foreign-scoped action keeps its qualified
name). A kit exposes only its OWN scope subtree plus unscoped declarations — a kit that
iterated the whole global surface once registered every app's actions on every kit (M×N
contamination, found live 2026-08-03); a deliberate composition passes
`registerStandardTools(kit, { scopes: [leftScope, rightScope] })`. Do NOT hand-write
get-params/set-params tools — that pattern is retired; for a new verb add
`action({ scope, name: "…", run })` next to the feature (the name must be a string literal on
an inline options object; genuinely dynamic registration — a library minting controls from
data — passes a PREBUILT spec object, which the compiler leaves alone and the runtime name
guard backstops), and reserve `kit.registerTool` for the genuinely bespoke
(name+description+`inputSchema`, idempotent by name). Bind controls in the UI through
`ControlSlider`/`ControlToggle`/`Dropdown` (they stamp `data-control` and read meta) or a
hand-rolled binding that declares `data-control="<name>"` itself.

Forwarding is unconditional: the toolkit publishes every namespace into
`window.__AIUI__.tools` (installed by the runtime, production included — the page dials
nothing). When an intent client is running, it relays each tab's tools to the channel, and
the session drives the page remotely via the `page_tools_list` / `page_tools_call` MCP tools
— no app wiring. **The activity bit**: a shell parks a page's namespace when the user routes
away — `SitePage.toolsNs` + `setSitePageActive` handle it for site pages; an app with its own
routing calls `kit.setActive(active)`. Parked tools stay listed (flagged) and callable.
`window.__AIUI__.tools.ledger()` prints a console.table-friendly enumeration.

Always provide one bounded `report()`. Components rendering cell values *outside* CellView
declare `data-cell="<name>"` — one attribute, a *name*, and it is the ONLY attribution
attribute ever written by hand. **NEVER hand-write `data-source-loc` or `data-cell-loc`** —
locations are compiler output (the `aiui()` plugin from `@habemus-papadum/aiui-source-processor`);
a typed-in `file:line:col` lies as soon as the file is edited and the resolvers cannot detect
it. An agent did this once instead of enabling the plugin, and the confident-but-wrong
resolutions it caused must not be repeated: if stamps are missing, fix `vite.config.ts` —
`aiui()` present, BEFORE `solid()` — never the markup (full contract:
[attribution.md](../../../../../../../packages/aiui-viz/docs/attribution.md)). Verify your own
work through this surface: `.tools`, `.call(name, args)`, `.report()`,
`.call("locate", { selector })`.

## Modal / stateful UI = the mode engine

When the UI has modes (arming, turns, talk windows, standing toggles), do NOT hand-roll signal
choreography — use the mode engine (`solidModeEngine` from the aiui-viz root; framework-free
core in `aiui-viz/modal`, regions built with `ladder`/`toggle`/`choice`):

- **Regions are settings** (ladder / toggle / choice — standing, `durable`, agent-visible via
  `agent:`); **claims are operations** (pure derivations from (state, ctx), reconciled after
  every commit, per-claim status idle|pending|active|error|stale; the newest desire wins).
  Never store operation status in ad-hoc flags — derive it.
- **Commands are the only writers** — keys, bar caps, agent `set`, system events all dispatch
  through one pure reducer; cross-region invariants are declared `excludes` (applied after
  every command AND to the initial state); a command's `available` map is a GATE, not a hint —
  an unavailable command is refused by dispatch. Never write a region's signal directly — and
  never read back after a write, you don't need to: dispatch is `flush()`-committed and machine
  state is a plain frozen object, safe to read anywhere, any tick.
- **Enablement is derived**: caps and keys ask `canDispatch` (dry-runs the reducer INCLUDING
  excludes — "would this do anything?"). The bar is a projection of the spec (tree → depth
  rows; labels stable — lit carries "engaged"; hold caps stay enabled while either half of the
  gesture applies).
- Regions with `agent:` auto-register a `control()` whose setter dispatches — never mirror
  engine state into separate controls or signals.
- Imperative events from outside (global shortcuts, sockets) cross in as sequential idempotent
  dispatches, re-reading committed state between steps — copy
  `packages/aiui-intent-client/src/activation.ts`. Spec worked example:
  `packages/aiui-intent-client/src/spec.ts` (its `BEHAVIOR.md` is the decided interaction
  contract); rationale: the mode-engine design note (git history).

## Solid 2.0 (beta) instant-bite gotchas

- No `onMount` (ref callbacks), no `classList` (compute class strings); `render`/`JSX` come from
  `@solidjs/web`; `<Show>` non-keyed callback children receive an *accessor*.
- No `<Index>` either — `<Repeat count={n}>{(i) => …}` is the position-keyed list. Reference-keyed
  `<For>` over freshly-computed row objects re-creates DOM nodes on every recompute — a node
  detached mid-gesture loses its pointerup (a press-and-hold button died on its own lit flip).
  Render recomputed projections with `<Repeat>`; attributes update in place on a persistent node.
- A disabled button swallows pointer events: press-and-hold UI must keep the button enabled
  across the whole gesture (down OR up still dispatchable), or the release wedges the hold.
- Writes inside owned scopes throw in dev — internal bookkeeping signals need
  `{ ownedWrite: true }`; otherwise write from handlers or `queueMicrotask`.
- `createEffect(source, handler)`: the handler is untracked for *reads* too — consume the value
  the source computed, never re-read signals in the handler. (And for imperative-system
  crossings, use `bridgeEffect` — see the structure section.)
- A write COMMITS at the next microtask, and the reactive graph is the only reader of your
  writes: `set` then `get` in the same tick reads stale *everywhere Solid didn't call you* (event
  handlers, timers, sockets, tool `run`s — not just tools and tests), and a memo over the fresh
  write is exactly as stale. Never read back — branch on the value you computed or the setter's
  return. A flow that must observe its own writes calls `flush()` from `solid-js` (`flush(fn)`
  also runs effect handlers synchronously). Reads inside the graph (memos, effect computes, JSX,
  cell deps) are always fine. `control()`/`durableSignal()`/`createStore` share these semantics.
  Mode-engine machine state is exempt by construction: dispatch is flush-committed and state is
  a plain frozen object — never stale to read.
- A cell is callable — never put identity on `.name` (Function.name is read-only).

## HMR rules that keep live state safe

`import.meta.hot.accept(dep, cb)` only works in a *direct importer* of dep, and every import
path to a changed module needs an acceptor or the page full-reloads (sever secondary imports by
passing values through constructors). Never `optimizeDeps.include` a workspace-linked package
(lockfile-keyed cache serves it stale). Don't edit `*.worker.ts` or `store.ts` while a live run
matters — those force full reloads. Log every hot swap with what it preserved.

## Every app is a page AND a card (the site contract)

A scaffolded app has the dual shape from birth — standalone app and library:

- `src/main.tsx` mounts `src/page.tsx` inside `PageBoundary`; `src/index.ts` is the library
  barrel; `package.json` carries the `aiui.sitePage` marker (title/desc/order/card) and the
  `.` / `./page` / `./card` export subpaths.
- `src/page.tsx` exports the app as a **`SitePage`** (the contract lives in aiui-viz):
  `{ title, App, toolsNs: appScope.name, activate?(), deactivate?() }`. The lifecycle is
  **pause-not-destroy**: leaving a route PARKS continuous work (rAF loops); event-driven
  resources — workers between jobs, DuckDB between queries, idle cells — cost nothing
  off-route and need no handling; returning re-mounts components over the surviving durables,
  exactly like an HMR swap. Both hooks must be idempotent. A shell calls
  `setSitePageActive(page, active)` — never bare `page.activate?.()` — so the lifecycle and
  the tools-activity bit cannot drift.
- `src/card.tsx` exports a **`DemoCard`** `{ blurb, Preview }` — deliberately SEPARATE from
  the page: a landing mounts EVERY app's preview at once, so a Preview is built from the
  app's *pure model only*, never its store/graph, and wears its own PageBoundary in the shell.
- **Routes are data.** The gallery (`demos/gallery`) imports no demo: its discovery plugin
  scans `demos/*/package.json` for the `aiui.sitePage` marker and serves `virtual:demo-pages`;
  router, nav, lazy page loaders, and landing cards all derive from it. Adding an app to the
  site = the marker existing.
- One document, client-side routing — **never separate `.html` entries**: one document keeps
  an open intent turn alive across page switches, and every internal link must be
  routed/intercepted, since one bare hard-navigating anchor kills the turn.
  `demos/gallery/src/site/` is the worked example.

## Page anatomy & theming

A notebook page reads like a paper (full conventions: the style-guide doc): `section[id]`
blocks — the complete dashboard overview FIRST (everything on screen at load), then explanatory
sections re-rendering their own instances of the same widgets (double-mounting shared cells is
free and intended; durable canvases stay in the overview only), then theory (equations the page
actually demonstrates, via `TeX` from `aiui-viz/site` — never raw katex, you'd lose the
`data-tex` stamp), then experiments naming exact controls. `TocRail` + `SiteNav` from
`aiui-viz/site`.

Theming, current truth: the in-repo demos are **dark-only by owner decision** — the shared
look lives in `demos/journal` (`@habemus-papadum/aiui-journal`: the theme literals — `chart()`,
`plot()`, `mode()`, `isDark()` — plus `styles.css`, the `:root` tokens and notebook chrome),
and the page head stamps `data-theme="dark"` pre-paint. `colorMode` (`aiui-viz/site`) is the
system-following facility for an app that wants both modes — tokens on `:root` plus a
`prefers-color-scheme` media query, a reactive theme signal for literal colors (charts/SVG),
palettes validated per mode against each mode's surface — but note nothing in-repo currently
exercises it. When an app does carry two modes, figure colors (a sim canvas + its legend
chips) are cross-mode *constants* while panel-chart colors are *per-mode*: same hex in dark,
they diverge in light. A demo's page CSS uses demo-prefixed class names (or is scoped under a
root class, like `demos/gears`' `.gears`) so nothing leaks onto a sibling mounted in the same
document.

**Phones and desktops** (full section in the style-guide doc): one component tree reflowed with
CSS — never a mobile fork or a JS `isMobile` branch (a media query IS the device-conditional
logic and can't drift from the viewport). Desktop rules are the base; phone changes layer inside
`@media (max-width:…)` so the wide layout stays byte-identical (verify at ~1440px). Fluid-first —
`minmax(0, Npx) minmax(0, 1fr)`, `clamp`, `auto-fit`, `max-width` caps over fixed px — and put
each breakpoint where THIS content breaks, not at device names (TocRail <1280, seismos 860,
circle 600); target the CSS-px band 360–414. Imperative islands (sim canvases, `PencilSurface`
from `@habemus-papadum/aiui-pencil`) re-fit to their box via ResizeObserver, so a CSS reflow is
enough — no device JS; give a stacked drawing surface an explicit height. Absolute overlays that
float beside a wide figure must rejoin the flow and stack on phone (circle's readout/dock buries
a narrow board otherwise); a drawing surface keeps `touch-action:none` while its stacked
container allows `pan-y`. Preview by driving a real browser at a phone viewport (DevTools device
mode, or the session browser's `emulate`/`resize_page` + screenshot loop) sweeping 360/390/414,
then re-shoot ~1440px to prove desktop is untouched.

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

## Composing and reusing (slices + scopes)

Scoping is the default posture (the app itself is a scope); a **slice** extends it to reuse.
When the same instrument is wanted in two apps — or twice on one page — the unit of reuse is a
**pair of factory functions**, never a graph object: a store factory declaring the control
surface, and a cells factory building the derived cells inside the app's ONE `hotCellGraph`
(a slice never owns that ritual — it's bound to the app module's `import.meta.hot`). Both take an
explicit `Scope` (`scope("left")`) and thread it into every declaration (`control({ scope, … })`,
`cell(deps, compute, { scope })`, `action({ scope, name: "…", … })`, `s.durableSignal(…)` for
internal keys): the compiler still injects the leaf name/description, and the scope qualifies the
effective identity (`left/freq`) so two instances get distinct durable state, distinct tools
(`left/kick`), and instance-correct dependency edges. **Never instantiate a slice factory twice
without distinct scopes** — same call site means same injected name, and the instances silently
share one durable state (indistinguishable from an HMR re-eval; nothing warns). Identity across a
package boundary: a workspace-linked slice is compiled by the consuming app (dotdot-relative
locs, automatic); a published library runs `sourceLocatorVite({ locPrefix: "@you/pkg/" })` (from
`@habemus-papadum/aiui-source-processor`) in its own build/vitest configs. Worked example:
`demos/oscillator` consumed twice by `demos/twins`.

## The library is young — treat it as improvable, not frozen

`@habemus-papadum/aiui-viz` is an early library in a young project. Before leaning on one of its
exports for something load-bearing, **check that the behavior you need is pinned by a unit test**
(`packages/aiui-viz/src/*.test.ts*` — `cell.test.ts` covers the cell semantics); if it isn't,
add the test rather than assuming. When app code needs a pattern the library almost provides —
or you find yourself writing the same helper in a second app — the right move is usually to add
the abstraction to aiui-viz with tests and docblocks, then use it, leaving the app simpler.
That is how `hotCellGraph`, `durableSignal`, `bridgeEffect`, `throttled`, and
`registerStandardTools` came to exist: each was boilerplate copy-pasted into every app until it
was extracted. Do not re-introduce that pattern by working around the library in app code, and
do not treat its current surface as complete.

## Definition of done

Each playbook layer has its own done (see the playbook section above); the whole change is done
when: typecheck + unit tests + lint pass. Tests mean two layers: pure logic (stats, algorithms,
worker math in its realm-free module — playbook layer 1) AND the surface + graph headless via
`aiui-viz/testing` — build cells **inside** `cellHarness(build)`'s callback (outside an owner
they throw `NO_OWNER_BOUNDARY`), `resetControlSurface()` in afterEach (restores initials, keeps
registrations), then move **each** dependency — every `control` included — and
`await whenReady(cell)` (the harness absorbs write batching and owners); streaming cells assert
via `recordCommits`, cancellation via `whenState(cell, "held")`; a `set` through the derived
tool should round-trip into an observable recompute and the dependency edges should appear in
`report`. The per-input probe is the instrument that catches an undeclared dependency. (The
compiler must be wired in `vitest.config.ts` — the template ships it; without it controls are
nameless and tests fail mysteriously.) Then drive the app through its own tool surface in the
session browser (zero console errors, `report()` sane, `bridges` clean, the mount wrapped in
`PageBoundary`); prove HMR preserves the running state for a component edit and a graph edit;
screenshot the result.
