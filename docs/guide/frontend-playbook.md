# Frontend: the playbook

The [user guide](./frontend-user-guide) teaches the pieces — cells, views, workers, the layout.
This page answers the other question: **in what order do you build an analytic frontend, and how
do you know each part is done?** It is written for whoever is doing the building, which in this
workflow is usually an agent with a human steering.

The shape is four layers. Each layer depends only on the ones before it, each has its own kind of
testing, and the rigor is deliberately front-loaded: the deeper the layer, the cheaper and more
exhaustive its tests, so confidence flows upward and the layers above stay thin.

| Layer | What it is | How it's verified |
| --- | --- | --- |
| 1 · Pure functions | domain math, no framework, no time | exhaustive unit tests (+ benchmarks) |
| 2 · Cells | the computation boundaries, where reality enters | headless cell tests (`aiui-viz/testing`) |
| 3 · Components | visualization elements consuming cells | behavioral DOM tests + the human's eyes |
| 4 · Application | pages, sections, keyboard modes, narrative | keymap tables + driving the tool surface |

The scaffolded starter (`npm create @habemus-papadum/aiui`) arrives with the four layers already
staged in miniature — `rose.ts` + `rose.test.ts` (layer 1), `scenery.ts` + `scenery.test.ts` +
`graph.ts` (layer 2), `ui/` (layer 3), `App.tsx` (layer 4) — and all of its placeholder scenery
**fenced with `<aiui-scenery>` markers**, so resetting to a blank canvas is a mechanical deletion
any small model can perform (the starter's `CLAUDE.md` § *Reset to a blank canvas* is the
three-step procedure). Reset first, then build in this order.

One warning before the layers, because it is the way this document gets misused:

::: warning A dependency order, not a waterfall
The layers order *dependencies and rigor*, not the project calendar. Do **not** build the entire
pure-function library before anything renders. This workflow steers by looking at the running
app — the human points at pixels — so get one thin slice through all four layers on screen early
(one function, one cell, one plot, one page), then deepen each layer in place. Every subsequent
feature repeats the same descent in miniature: what's the math? what's the boundary? what shows
it? where does it live?
:::

## Layer 1 — pure functions: the domain, with no clock

Everything that is *about the domain* — spectral fits, censuses, tilings, statistics — is written
as pure functions: values in, values out, no framework imports, no awareness of time, failure, or
the DOM. This code is **library-shaped, not app-shaped**: it models the domain (signal
processing, seismology, whatever the science is), not this particular page, and it should read
like it could be extracted and reused — because it often will be.

Rules that make the layer hold:

- **Realm-free.** No `solid-js`, no `window`, no `import.meta.env`. This is what lets the same
  module run in the page, in a worker, and under Vitest with zero ceremony. (Type-only imports
  from mixed barrels are fine — they erase.)
- **Tested exhaustively, here.** This is the cheapest place to be thorough — plain functions,
  plain asserts, property-style edge cases. A bug caught here costs a test run; the same bug
  caught through a chart costs a debugging session. The gallery's `analysis/core.test.ts` is the
  worked example.
- **Measured, not assumed.** When a computation might be slow, benchmark it (Vitest's `bench` is
  enough) *before* deciding where it runs. The numbers decide three things later: whether the
  cell that wraps it needs a worker, whether it needs chunking + progress, and eventually whether
  it justifies another implementation modality (Wasm, WebGPU). Those alternates — and how to
  choose between them — deserve their own performance guide someday; the playbook's rule is just:
  **decide with measurements, and keep the pure JS implementation as the reference the fast one
  is tested against.**

Done when: the functions are tested against their edge cases, the slow ones have numbers, and
nothing in the layer imports anything above it.

## Layer 2 — cells: where reality enters

**Layer 2 opens by declaring the control surface** — the experiment's independent variables and
verbs, before any cell exists:

```ts
/** Diffusion constant — how fast heat spreads. */
export const kappa = control({ value: 0.1, min: 0.01, max: 1, step: 0.01 });

/** New random seed; the evolution recomputes. */
action({ name: "re-seed", run: () => seed.set((s) => s + 1) });
```

Names, definition sites, and descriptions are compiler-injected (the doc comment IS the
description); constraints are declared once and validate every write — widget, keyboard, and the
agent's derived `set` tool alike; each `action()` becomes a real named agent tool. Curate it:
knobs are controls, internal state stays plain signals. Declaring is exposing — the hand-written
get-params/set-params tool pair this framework once required is gone.

Then organize the *application's* dataflow as
[cells](./frontend-user-guide#step-3-your-first-cell)
— still no UI. A cell is a **computation boundary you chose on purpose**: the unit that
recomputes together, cancels together, fails together, and reports progress as one thing. Layer 1
pretended time and failure don't exist; this layer is exactly where they're allowed in — fetches
that fail, workers that take seconds, streams that arrive in pieces, runs that must die when a
slider moves.

Two structural facts to hold onto:

- **Cells are not 1:1 with pure functions.** One cell may call five layer-1 functions in
  sequence; one layer-1 function may serve half the graph. The pure layer is vocabulary; the cell
  graph is *this app's sentences* — its deliberate choices about granularity: too few cells and a
  small change recomputes the world; too many and the graph is bookkeeping.
- **The worker file is a seam, not a home.** When a benchmark says "worker", the `.worker.ts`
  file stays a thin shell speaking the `workerStream` protocol (run/cancel in; progress, partial,
  done, error out) and the *math stays in layer 1* — chunked so it can yield a macrotask between
  chunks (cancellation needs one) and stream the cheap result early. If domain logic starts
  accumulating inside a worker file, it has escaped the testable layer; pull it back down.

**Test the graph headless — this is not optional.** Dependency tracking has one silent failure
mode (an input read in compute instead of deps: the cell goes quietly stale), and a headless test
that moves each input is the instrument that catches it. The library ships a harness,
[`@habemus-papadum/aiui-viz/testing`](/packages/aiui-viz/), that buries the Solid trivia
(owners, batching, tick counting):

```ts
import { cellHarness, whenReady, whenState, recordCommits } from "@habemus-papadum/aiui-viz/testing";

const h = cellHarness(() => buildGraph());        // owner + liveness handled
expect(await whenReady(h.cells.peaks)).toHaveLength(3);

threshold.set(0.9);                               // move ONE input…
expect(await whenReady(h.cells.peaks)).toHaveLength(1);   // …prove it noticed

capture.set(undefined);                           // the cancel gesture
await whenState(h.cells.analysis, "held");        // idle, last value standing

h.dispose();
```

The per-input probe (`set` one input → `whenReady` → assert the output moved) repeated for every
input of every cell is the layer's definition of done. Streaming cells add `recordCommits` (did
downstream see three partials, or one settled value?); cancellable cells add a `whenState(…,
"held")`. The library's own `testing.test.ts` and `cell.test.ts` are the worked examples —
including the out-of-sync bug, kept as a deliberately failing dependency so its signature stays
documented.

Done when: every control is described and constrained; every cell has its inputs probed, its
failure path asserted (`errored` keeps `latest()`), and its cancellation observed; a `set` through
the derived tool round-trips into an observable recompute; and the dependency edges appear in
`report` — all without a browser (`resetControlSurface` between cases; the compiler runs under
Vitest).

## Layer 3 — components: elements that show cells

Only now, UI. Components consume cells and render them — a plot, a table, a stat tile — and the
one discipline that keeps this layer almost logic-free: **components are pure readers.** Cells in
(through the `graph()` accessor), DOM out; parameters written back through their signals; nothing
computed in the component that belongs in a cell. `<CellView of={…}>` supplies the whole
lifecycle (pending, error + retry, keep-latest, progress, the attribution stamps) so the
component body is just "value → markup". Controls bind through `ControlSlider`/`ControlToggle`
(bounds, step, and unit come from the declaration — never re-typed in JSX; the label carries the
`data-control` stamp), with hand-rolled bindings for shapes the porcelain doesn't cover — which
is exactly how the next porcelain earns its extraction evidence.

Reuse falls out of purity: the same component renders in the hero overview and again in a
deep-dive section, reading the same cell — double-mounting shared cells is free and intended.

Testing, two passes, in order:

1. **Behavioral, now.** A jsdom test that renders the component over a real cell and asserts the
   contract: the value appears, the error box appears when the cell errors, the `held` state
   reads quiet, the `data-cell` stamp is present. The library's `cell-view.test.tsx` shows the
   pattern. These are cheap precisely because the component has no logic of its own.
2. **Visual, later — and the first visual tester is the human.** In this workflow a person is
   *already watching the app* while the agent works; use them. Drive the change, look at it
   together, move on. Automated visual regression (screenshot diffing) earns its considerable
   upkeep only once the app has stabilized and matters enough that silent visual drift is a real
   risk — add it then, not on day one.

Done when: each component has its behavioral test, and a human has actually looked at it.

## Layer 4 — the application: pages, modes, narrative

Last, the layer where it becomes *an application* rather than a pile of instruments: the page
anatomy (a complete dashboard overview first, then explanatory sections re-rendering the same
widgets, theory with real mathematics, an experiments section — the
[style guide](./frontend-style-guide) owns these conventions); keyboard interactions as **modal
command structures** (the `aiui-viz/modal` kit: modes, layers, and surfaces as data — never
scattered `addEventListener("keydown", …)` calls, with bindings dispatching the SAME registered
actions and validated controls the widgets and the agent use); and, when one page isn't enough, the
progression across pages — an introductory notebook flowing to a deeper one, each page its own
entry so leaving it frees its GPU contexts and workers by construction.

This layer is deliberately late because it's the most tasteful and least testable — but not
untestable: the modal kit keeps keymaps as pure tables (unit-test the bindings and the Esc
ladder), and the whole app is drivable through its own tool surface — which is the layer's
definition of done: `report()` is sane, every user operation has its tool twin, and the agent can
verify a feature by calling it rather than squinting at pixels.

## Running through all four: the tool surface and the loop

The agent tool surface is not a layer — it **accrues alongside layers 2–4**: a reporter next to
each cell worth observing, a tool next to each operation a user can perform, registered where the
capability lives (`registerStandardTools(kit)` first — `locate` and the `cells` table come free).
By the time layer 4 closes, the surface *is* the app's integration test.

And the loop that ties it together, per slice: descend (math → boundary → element → placement),
test at each layer with that layer's instrument, then drive the result through the tool surface
in the session browser and prove a hot edit preserves the running state. Then pick the next
slice.

## Where to go next

- [User guide](./frontend-user-guide) — how to write each piece this playbook sequences.
- [Design choices](./frontend-design-choices) — why the pieces are shaped this way.
- [Hard-won details](./frontend-hard-won) — the findings ledger (worker choreography, HMR
  routing, theming).
- `demos/walkthrough` — this playbook executed in order on one small app (1-D diffusion), with
  **every layer left standing as its own page** (`step1.html` → the finished index) and
  `WALKTHROUGH.md` narrating each diff. Start there.
- `demos/gallery` — three notebooks whose directory layout *is* this playbook, at real scale.
