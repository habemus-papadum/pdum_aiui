# Frontend design choices

The level-2 document: what we actually built, how it works, and why — written for a reader who
designs frameworks for a living. [Frontend for agents](./frontend-for-agents) is the conceptual
overview; [Hard-won details](./frontend-hard-won) is the ledger of low-level findings this page
occasionally leans on; the [Style guide](./frontend-style-guide) carries the authoring
conventions built on these mechanisms. Code lives in `packages/aiui-viz` (the library) and `demos/gallery`
(two reference notebooks — morphogen, aztec — that exercise everything below).

## 1 · The cell: a thin layer over an async-first reactive core

We target SolidJS 2.0 (beta), whose rebuilt core made async first-class: memos accept promises
and async iterables, every yield commits transactionally to the graph, reading a not-yet-ready
value suspends the reader (`NotReadyError` as control flow), stale values are served while new
work is pending, and superseded runs are discarded with their `onCleanup`s fired. That is most of
an Observable runtime. What remains application-critical, and what `cell()` adds
(`aiui-viz/src/cell.ts`, ~200 lines):

```ts
const analysis = cell(
  () => {                       // deps: sync, tracked; undefined ⇒ hold
    const c = capture();
    return c ? { ...c, threshold: threshold.get(), quality: quality.get() } : undefined;
  },
  fromWorker<AnalysisParams, AnalysisResult>(analysisWorker),
);
```

- **`ctx.signal`** — an `AbortController` per run, wired to `onCleanup`, so supersession actually
  stops fetches and workers rather than merely ignoring them.
- **`ctx.progress`** — the framework has no notion of progress; loading chrome needs one.
- **`settled()`** — because every yield of a stream is a first-class committed value,
  `isPending()` is false *between* yields; "is this run finished" needs its own bookkeeping.
- **Non-throwing introspection** — `state()` / `latest()` / `error()`. Raw reads throw before the
  first value, and an errored memo reads as `undefined` *and drops its previous value*, so the
  cell caches the last value produced by any run (surviving errors) and exposes a seven-state
  machine (`unresolved · pending · streaming · refreshing · held · ready · errored`). `held` is
  the explicit deps gate with a value in hand — distinct from `refreshing` (a new value is
  actually coming), so a cancelled computation reads as calm, not as perpetually loading.
- **Deps gating** — `deps` returning `undefined | null | false` holds the cell, implemented as
  the idiomatic 2.0 "not yet" (throw `NotReadyError`). Reading another pending cell inside `deps`
  holds automatically — the old `ready()` combinator dissolved into the framework.
- **Stream policy** — `stream: "commit"` (default: every partial propagates) or `"latest"`
  (partials visible only on `latest()`; one commit on completion), plus `settledOnly(cell)` for
  per-consumer gating. This is the knob that reconciles live streaming with expensive downstream
  work.
- **Retry** — `refetch()` routes to the error boundary's `reset()` when errored (the only way to
  re-run a failed computation), `refresh(memo)` otherwise.

Deliberately out of scope: caching, deduplication, query keys. Feed a query library's results in
as plain inputs if you need them; the cell layer is about *dataflow semantics*, not data fetching.

**Consequence worth stating:** cancellation almost disappears as a concept. Input changes
supersede; supersession aborts; the worker protocol translates abort into a `cancel` message. The
demo's one explicit cancel button sets the deps signal to `undefined` — "hold until further
notice" — and the same machinery does the rest while `latest()` keeps the last result on screen,
with the cell reporting `held` so the UI shows it quietly rather than as endless loading.

## 2 · Identity: names are injected, not written

> How these stamps are *consumed* — the resolution ladders that turn a text selection or a drag
> rectangle into elements, cells, and source locations in the composed prompt — is its own
> concepts page: [Attribution: gesture → source](./attribution).

Attribution, the registry, and HMR all need stable identity, and nobody should have to write it.
A compile-time pass — the dev overlay's source-locator (`packages/aiui-dev-overlay/src/source-locator.ts`,
enabled via `aiuiDevOverlay({ locator })` in an app's Vite config) — rewrites cell call-sites in dev:

```ts
const catalog = cell(deps, compute);
// becomes
const catalog = cell(deps, compute, { name: "catalog", loc: "src/model/graph.ts:77" });
```

Named cells self-register into a per-page registry (`cellRegistry()`) and deregister via
`onCleanup` on their reactive owner — so a graph hot-swap replaces the population atomically and
the registry is HMR-correct with zero bookkeeping. The registry is the agent-facing attribution
table: name → live state → definition site.

The same pass stamps every host JSX element with `data-source-loc="file:line:col"`. Together with
`data-cell` (below) these two attributes are **the legibility contract**: framework-neutral by
design — the mechanism here is Solid-specific, but a React implementation of the same two
attributes plus a registry would serve an agent identically.

## 3 · HMR: durable roots, a disposable graph, and a box

The architecture that makes "edit under a running experiment" safe has three parts
(reference: `demos/gallery/src/model/store.ts` and `graph.ts`; background: the archived
*HMR for agentic coding* notes in the repo's `archive/`):

**Durable roots** are owned by a keyed, idempotent registry:

```ts
export const sim = durable("sim", () => ({ engine: new GrayScottEngine(...), loop: startLoop(...) }));
```

`durable(key, create)` creates once per page and *adopts* forever after — no module re-evaluation
can double-create a worker or reset a slider. The registry lives on `window`, outliving any
module graph churn. Parameters (the user's slider positions — the most precious state of all) are
durable signals; history rings are durable structures with a version signal.

**The graph is disposable and published through a box.** The dataflow module rebuilds its entire
cell graph on every hot edit — dispose the old reactive root, build a new graph over the same
durable roots, set it into a durable *box signal*:

```ts
graphBox.get()?.dispose();          // module re-evaluation swaps the old graph out
graphBox.set(build());              // …and publishes the new one
if (import.meta.hot) import.meta.hot.accept();
```

Components subscribe to the box (`morphoGraph()`), never to a module export, so no stale cell
reference can survive a swap. This is the pragmatic answer to the `redefine` primitive the
archived solid-cells notes wish for: whole-graph swap costs the
in-flight runs of *all* cells on a dataflow edit (defensible — the edit plausibly invalidated
them) in exchange for needing no framework surgery. Per-cell redefine remains the refinement path
if the coarseness ever hurts.

**Durable DOM islands.** The `<canvas>` is created outside any component and adopted by whichever
component render is current — a hot-swapped component re-parents the same canvas, so the WebGL
context and the accrued field survive. The successor-safe cleanup rule this requires (never
un-parent a resource your replacement may already have adopted) is a ledger entry.

A payoff worth naming: **widgets are free to double-mount.** Because controls write shared
durable signals and panels read shared cells, N copies of a panel are just N subscribers to one
source — the reference notebooks render each visualization twice (in the at-a-glance overview
and again beside its explanatory section), and the copies stay locked together with zero extra
plumbing; solid-refresh even hot-swaps all N together. The only thing that cannot double-mount
is a durable DOM island (one canvas element, one parent) — which is why the canvases live in the
overview alone.

Two disciplines make the whole thing legible: the **module layout is the API** — durable wiring
(`store.ts`, rarely edited) is a different file from disposable dataflow (`graph.ts`, edited
constantly) and components (`ui/`, hot-swapped by solid-refresh); and **reloads are observable** —
every swap logs what it preserved (`[morpho:hmr] shaders recompiled in place — field preserved`),
because "the edit silently discarded the state that mattered" must be diagnosable from the
console.

Vite specifics — acceptance topology, why the shader handler lives in its direct importer, what
forces full reloads — are ledger material, but one is architectural: a **self-accepting dataflow
module absorbs update propagation** for everything beneath it, which is what lets `store.ts`
edits hot-apply instead of bubbling to a full reload.

## 4 · Imperative islands and cadence bridges

A 60 Hz render loop does not belong in a reactive graph. The pattern
(`demos/gallery/src/sim/`, mirrored by aztec's player):

- The engine is a plain imperative class; the rAF loop never touches signals.
- **Inbound:** effects push parameter changes in — `createEffect(params, p => engine.setParams(p))`.
  Reactivity terminates at a method call.
- **Outbound:** the loop publishes a small snapshot into *one signal* at a chosen cadence (~4 Hz)
  — the rate consumers can absorb, not the rate the sim runs. Everything downstream hangs off
  that signal.

The same seam discipline holds for imperative libraries: Observable Plot lives behind one
`PlotFigure` component (`aiui-viz/plot`), d3 contributes only scales to plain JSX. And the budget
rule is structural: cheap reductions inline on the main thread (`sim/stats.ts`), anything heavier
in a worker (`analysis/`).

## 5 · Long work: the worker protocol

`workerStream()` (`aiui-viz/src/worker-stream.ts`) turns a worker into an async generator a cell
consumes directly — partials stream into the graph, progress drives `ctx.progress`, and abort
posts a `cancel` the worker honors. The worker-side contract:

- **Yield to the event loop between chunks with a macrotask** — message events are macrotasks; a
  microtask yield can never observe a cancel.
- Stream the cheap phase early (the census partial lands seconds before the wavelength), `done`
  carries the final value.
- Keep the math in a pure, realm-free module (unit-testable headlessly); the worker file is only
  choreography. Errors post `{ type: "error" }` — a worker throw must become a visible, retryable
  cell state.

One durable worker can serve several cells: a discriminated `run` payload plus the protocol's
per-request ids demux concurrent streams cleanly (aztec runs growth and permanent-verification
through one worker).

## 6 · The tool surface and its pipeline

`agentToolkit(ns)` (`aiui-viz/src/agent-tools.ts`) installs `window.__<ns>` — one namespace per
notebook page — holding `tools` (name, description, loose `params` docs, optional real JSON Schema
`inputSchema`, `run`), `call(name, args)`, and `report()` assembled from pluggable reporters.
Three semantics carry the design:

- **Idempotent by name** — re-evaluated modules replace their tools; the registry is HMR-safe for
  free.
- **Registered beside the feature** — the regime-jump tool next to the catalog cell. The surface
  accumulates with the app.
- **`report()` is one bounded, JSON-serializable call** for the whole picture — the single most
  used call in agent-driven verification of both reference apps.

The pipeline (frontend → dev overlay → channel → agent-visible MCP tools, with calls routed
back) is **implemented**: `agentToolkit` forwards each namespace's tool set to the overlay's
tools bridge (`window.__AIUI__.tools`, installed by the Vite plugin's mount module), which
declares it over the channel's `/tools` websocket; the session reaches it through the
`page_tools_list` / `page_tools_call` MCP tools. The load-bearing properties, carried over from
the handoff (`packages/aiui-dev-overlay/handoff/frontend-tool-registry.md`): registration is
*declarative* (always re-register the full set; identity = namespace + name), forwarding is
*content-hashed* (page reloads with unchanged tool sets are invisible upstream), and
implementations are resolved *at call time* (HMR swaps closures invisibly). The ergonomic
direction remains ImGui-like single-source parameter meta — define `{min, max, step,
description}` once and derive the slider, the tool schema, and the report entry — plus
auto-derived read-tools from the cell registry, and per-tool dynamic MCP registration in place
of the list/call pair.

## 7 · Attribution: boundaries, not magic

`CellView` (`aiui-viz/src/cell-view.tsx`) — the wrapper giving every async value its notebook
chrome (spinner + progress before the first value, keep-last-render dimmed under a progress
stripe, error box with retry) — also stamps `data-cell` with its cell's name and
`data-cell-loc` with its definition site (the `cell(...)` call's `file:line`, babel-injected),
so DOM-contract consumers — the shot locator, the overlay's VS Code jump mode — can open the
cell's source without a registry lookup. One deliberate
library seam: CellView ships *behavior and class names*, never styles — the consumer owns the
CSS for `cell-body`, `cell-pending`, `cell-error`, `progress-stripe` and friends (the demo's
`styles.css` is the worked example), so the library imposes no theme. That makes the
common case free: wherever a cell's value renders through the standard wrapper, the element
subtree is attributed. Components that render cell values without the wrapper declare one
attribute (see the demo's StatsTiles) — the entire manual affordance.

We deliberately rejected two stronger designs for now: syntactic detection of cell reads inside
JSX (defeated by any indirection — our own graph-accessor layout breaks it) and reactive-graph
introspection (per-element effects know their true dependency sets — precise, but requires
framework dev-mode internals). Boundary stamping is coarse but honest, costs nothing, and the
registry closes the loop for anything it misses.

## 8 · Pages, entries, and resource lifecycles

Documented in [Frontend for agents](./frontend-for-agents#many-notebooks-one-lab) at the concept
level; the design commitments: **Level 1** (separate Vite entries, plain-link nav, full reload as
the resource policy — exercised by morphogen|aztec) and **Level 2** (one entry, lazy page
modules, per-island suspend policies: `pause` keeps the GPU context and stops the loop;
`hibernate` reads state back to CPU and releases the context — mandatory at scale because
browsers cap live WebGL contexts per tab (~8–16, oldest silently killed); `dispose` recomputes).
Durable-registry namespaces per page; tool namespaces per page (`__morpho`, `__aztec`); URL for
shareable state.

**The anatomy of a notebook page.** A scientific notebook reads like a paper, not a dashboard:
titled **sections** that interleave interactive panels with explanatory prose and real
mathematics (KaTeX; a ~10-line `Math` component rendering `katex.renderToString` covers it), in
a deliberate order — the laboratory first (the thing you play with), observables and analysis
with prose that says what the numbers *mean*, a **theory** section (the governing equations,
where the length scale comes from, what theorem is on display), and an **experiments** section:
concrete "things to try" that name exact controls, turning a visitor into an experimenter.
Structure is navigable Observable-Framework-style: a sticky right **TOC rail** built from the
page's `section[id] > h2` headings with scroll-position highlighting (hidden on narrow
viewports), and a slim shared **site header** whose notebook tabs carry one-line descriptors —
the discoverability answer for "there is more than one experiment here." Prose is part of the
notebook, not decoration; the agent writes it alongside the panels it explains.

**Theming: respect the system, tokenize everything.** Pages follow `prefers-color-scheme` with
no toggle: design tokens on `:root` (dark as the base, light under the media query), every
component color a `var()`, and a small reactive theme module (a signal on the `matchMedia`
listener) feeding the colors that must be literal — chart palettes, SVG strokes, Plot text.
Palettes are validated **per mode** against each mode's actual panel surface (the dataviz
procedure; the two modes get separately tuned steps, not an automatic flip). Simulation
canvases are the exception by design: they render as self-contained dark *figures* — like a
journal plate — identical in both modes, framed by the panel border.

## 9 · What the agent's diligence buys (design inputs, not features)

Because an agent writes the code, we design for habits no human team sustains: a tool and a
reporter beside every feature; progress threading through every long computation; the one-line
attribution affordance written every time; verification driven through the app's own tool surface
(both reference apps were verified that way, end to end, including their HMR behavior). A future
affordance unique to agents: when an edit renames or splits a cell, the *editor* can emit the
old→new identity mapping alongside the edit — solving the hardest HMR identity problem in a way
no human workflow ever could.
