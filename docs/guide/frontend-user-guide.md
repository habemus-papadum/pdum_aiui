# Frontend: user guide

This guide is for someone who has data, a computation, and something they want to see on a
screen — and who is **not** a frontend developer. You don't need to know React, or Solid, or much
JavaScript beyond "functions and objects exist." Concepts arrive one at a time, each on top of the
last.

One honest note before we start. This framework is built for a workflow where an AI agent writes
most of the code and a human watches, steers, and points. A few of its conventions are a little
more explicit than a human author would choose on their own — more scaffolding, more spelled-out
wiring. That is deliberate: explicit code is code an agent (and its future self, and you) can read,
test, and debug. Everything here remains perfectly writable by hand, and this guide teaches it that
way.

The other frontend pages are for framework designers: [Concepts](./frontend-for-agents),
[Design choices](./frontend-design-choices), and the [findings ledger](./frontend-hard-won). You
need none of them to use this one.

## The idea: a spreadsheet for computations

Think of a spreadsheet. Cell `B1` says `=A1*2`. You never tell `B1` when to recompute — you change
`A1`, and `B1` just updates. Everything downstream of `B1` updates too, in the right order, exactly
once.

This framework gives you that, for real computations: fetches, simulations, worker jobs that take
seconds. The unit is called a **cell**, and like the spreadsheet's, it knows three things: what it
depends on, how to compute its value, and who is watching. Unlike the spreadsheet's, its
computation can take time — so a cell also knows how to report progress, how to keep the old answer
on screen while the new one cooks, and how to *stop* cooking when the inputs change out from under
it.

If you have used an [Observable](https://observablehq.com) notebook, this is that model, written in
ordinary TypeScript.

## Step 1: a box that notices

Before cells, you need inputs. An input lives in a **signal** — a box holding one value, which
remembers who read it and notifies them when it changes:

```ts
import { durableSignal } from "@habemus-papadum/aiui-viz";

export const threshold = durableSignal("param:threshold", 0.5);

threshold.get(); // read → 0.5
threshold.set(0.7); // write → everyone who read it gets re-run
```

That's the whole interface: `.get()` and `.set()`. The "durable" part means the box survives a
live code edit — more on that in [Step 9](#step-9-where-everything-lives), and until then you can
ignore it. The string key just names the box.

## Step 2: your first cell

A cell is made from two functions:

```ts
import { cell } from "@habemus-papadum/aiui-viz";

const peaks = cell(
  () => ({ cutoff: threshold.get() }), //  1. deps: what do I depend on?
  (deps) => countPeaks(mySpectrum, deps.cutoff), //  2. compute: what do I produce?
);
```

Read it as a sentence: *"`peaks` depends on the threshold, and is computed by counting peaks above
it."* Move the threshold slider, and `peaks` recomputes. You never call it, schedule it, or wire it
up — declaring the dependency **is** the wiring, exactly like the spreadsheet.

The first function (**deps**) gathers the inputs into a bundle. The second (**compute**) receives
that bundle and returns the value. Keep that division of labor in mind; Step 3 explains why it
matters more than it looks.

## Step 3: how the cell knows when to re-run

This is the one piece of magic in the whole system, so it deserves a plain explanation.

There is no list of dependencies anywhere. Instead, the framework *runs* your `deps` function and
**watches which boxes it touches**. Every `.get()` (and every read of another cell) that happens
inside `deps` becomes a subscription. Touch it and you're subscribed; don't and you're not.

This is lovely — dependencies can't fall out of date with the code that declares them, because they
*are* code — but it has one sharp edge, and it is the most important gotcha in this guide:

**Only reads inside `deps` count. Reads inside `compute` are invisible.**

Here is the bug, in the flesh:

```ts
// BROKEN: `smoothing` is used but never declared
const curve = cell(
  () => ({ cutoff: threshold.get() }),
  async (deps) => {
    const raw = await fetchCurve(deps.cutoff);
    return smooth(raw, smoothing.get()); // ← read inside compute: NOT tracked
  },
);
```

This *runs fine* and produces the right answer — until someone moves the smoothing slider and
nothing happens. The cell doesn't know it depends on `smoothing`, because the read happened in
`compute`, not `deps`. No error, no warning; just a chart that's silently stale. The fix is
mechanical — read it in `deps`, take it off the bundle:

```ts
// FIXED: everything compute uses arrives through the bundle
const curve = cell(
  () => ({ cutoff: threshold.get(), sigma: smoothing.get() }),
  async (deps) => {
    const raw = await fetchCurve(deps.cutoff);
    return smooth(raw, deps.sigma);
  },
);
```

The rule that prevents it: **`compute` should be a pure function of its bundle.** If `compute`
mentions a signal or a cell directly, that's the bug. It is an easy rule for a human to state and
an easy one to drift from during a refactor — which is why [Step 7](#step-7-testing-your-cells)
shows a unit test that catches exactly this, and why an agent writing cells should write that test
without being asked.

## Step 4: putting a cell on screen

`CellView` renders a cell with all its life-cycle chrome handled:

```tsx
import { CellView } from "@habemus-papadum/aiui-viz";

<CellView of={curve} label="fitting curve">
  {(value) => <MyChart data={value()} />}
</CellView>;
```

You get, without writing any of it: a spinner (with a percentage, once you report progress) before
the first value; an error box with a **Retry** button if the compute throws; and — the notebook
feel — the previous chart kept on screen, gently dimmed under a progress stripe, while a new value
computes. Parameters move, the old picture stays legible, the new one replaces it when it's real.

Two mechanical notes, both easy to trip on:

- The child is a **function**, and it receives a function: `{(value) => ... value() ...}`. Write
  `value()`, not `value`. (This is how the UI library keeps things live; accept it as idiom.)
- `CellView` ships no colors or fonts. It emits stable CSS class names — `cell-body`,
  `cell-pending`, `cell-error`, `progress-stripe`, and friends — and your app styles them once.
  The starter app's `styles.css` already does.

## Step 5: cells that use other cells

Read the upstream cell in `deps`, the same way you read a signal — a cell is read by *calling* it:

```ts
const spectrum = cell(
  () => ({ id: sampleId.get() }),
  async (deps, ctx) => fetchSpectrum(deps.id, ctx.signal),
);

const peaks = cell(
  () => ({ spec: spectrum() }), // ← a cell read: subscribes AND waits
  (deps) => findPeaks(deps.spec),
);
```

Here's the part that feels like magic and is worth trusting: when `spectrum` hasn't finished yet,
`peaks` simply **waits**. You write no `if (loading)` checks, no callbacks, no ordering logic. The
framework holds `peaks` until `spectrum` has a value, then runs it; change the sample and the whole
chain re-runs in order. Chains of any depth work, and updates are atomic — you will never catch the
screen showing a new spectrum with the old sample's peak count.

(Under the hood, reading an unready cell throws a special `NotReadyError` that the framework
catches — that's the holding mechanism. You'll see the name in stack traces someday; it is
machinery, not a bug.)

One caution outside cells: **calling `spectrum()` in ordinary code** — a click handler, a
`console.log` — throws that same not-ready error if the cell isn't done. For those places use
`spectrum.latest()`, which never throws and returns the most recent value (or `undefined`). Every
cell also answers `state()`, `loading()`, `error()`, `progress()`, and `settled()`; the full table
is in [Step 8](#step-8-progress-and-cancelling).

## Step 6: the gate — "don't run yet"

If `deps` returns `undefined`, `null`, or `false`, the cell **holds**: it doesn't run at all.
That's how you express "nothing to do until…":

```ts
const analysis = cell(
  () => {
    const grab = capture.get();
    if (!grab) return undefined; // nothing captured yet — hold
    return { field: grab, cutoff: threshold.get() };
  },
  runAnalysis,
);
```

Corollary: since those three values mean "hold," none of them can *be* a dependency value. If your
input genuinely is a boolean, box it — `() => ({ enabled: flag.get() })` — so `false` travels as a
value instead of closing the gate. (The library's own test suite pins this exact case.)

The gate is also how you'll cancel things, in [Step 8](#step-8-progress-and-cancelling).

## Step 7: testing your cells

A cell graph is plain model code — no browser, no rendering. That makes it *unit-testable*, and
testing is not optional decoration here: it is the counterweight to the deps magic in Step 3. A
test that moves each input and watches the output is exactly the instrument that catches a
dependency the code forgot to declare.

The library's own suite (`packages/aiui-viz/src/cell.test.ts`) is the worked example — it even
includes the out-of-sync bug as a deliberately failing dependency, pinned in a test. The pattern
for your app:

```ts
import { createRoot } from "solid-js";
import { describe, expect, it } from "vitest";

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("the peaks cell", () => {
  it("recomputes when the threshold moves", async () => {
    let dispose!: () => void;
    const { peaks } = createRoot((d) => {
      dispose = d;
      return buildGraph(); // your graph.ts build function
    });
    await tick(); // let the first run land

    const before = peaks.latest();
    threshold.set(0.9);
    await tick();
    await tick();

    expect(peaks.latest()).not.toEqual(before); // it noticed ✓
    dispose();
  });
});
```

Three habits worth copying from that file:

- **`createRoot` wraps the graph** — cells need an owner; the disposer is your teardown.
- **`await tick()` after every `set`** — writes are batched (see the
  [gotchas](#gotchas-that-bite-exactly-once)); a read in the same instant sees the old value. Two
  ticks after an async compute is common.
- **Assert through `latest()` and `state()`** — they never throw, so tests read cleanly.

If you (or your agent) write a cell with more than one input, write the test that moves *each*
input. It is five lines per input and it converts the framework's one silent failure mode into a
loud one.

## Step 8: progress, and cancelling

So far `compute` has taken a second argument we've ignored: `ctx`. It carries three things.

**`ctx.progress(fraction)`** — call it with a number from 0 to 1 as your computation advances.
`CellView` turns it into the percentage next to the spinner and the width of the progress stripe.
That is the entire progress API.

**`ctx.signal`** — an [`AbortSignal`](https://developer.mozilla.org/docs/Web/API/AbortSignal) that
fires when this run is *superseded*: its inputs changed while it was still working. Pass it to
`fetch(url, { signal: ctx.signal })` and the network request genuinely stops; in a loop, check
`ctx.signal.aborted` between chunks and return early. You never trigger this yourself — moving a
slider does. This is the framework's quiet superpower: **cancellation is automatic**. Old work
stops because new work started.

**`ctx.previous`** — the last value this cell produced, if you want to warm-start from it.

That leaves deliberate, user-pressed **cancel**. There is no `cell.cancel()` — instead, remember
the gate from Step 6: cancelling *is* closing the gate.

```ts
const cancelAnalysis = () => capture.set(undefined);
// gate closes → in-flight run's ctx.signal aborts → cell goes quiet
```

After that, the cell reports the state **`held`**: it has its last result, nothing is running, and
nothing is coming. `CellView` shows the last result plainly — not dimmed, no stripe — which is
exactly what a cancelled computation should look like. (`held` is distinct from `refreshing`,
which means "a new value is actually on the way, keep showing the old one dimmed.")

The full state table, for reference — you rarely branch on these yourself, but `CellView` and the
dev tools speak them:

| `state()` | Meaning |
| --- | --- |
| `unresolved` | never produced a value; gate closed or inputs not ready |
| `pending` | first run in flight |
| `streaming` | producing partial values right now (Step 10) |
| `refreshing` | has a value; a newer one is on the way |
| `held` | has a value; gate closed — idle, at rest |
| `ready` | has a settled value |
| `errored` | the run threw; `error()` has it, `latest()` still serves the old value |

## Step 9: where everything lives

Here is the part where we ask you to copy a shape without fully deriving it. The payoff is **hot
reload that never loses your work**: you (or the agent) edit code while a simulation runs, and the
simulation, the slider positions, and the history all survive the edit. Every aiui app is split
into three files to make that true:

**`src/model/store.ts` — things that survive edits.** Your parameters, and later your workers and
canvases. This is where `durableSignal` from Step 1 earns its name: on a live edit, a durable
signal is *re-found*, not re-created, so the slider the user positioned stays put.

```ts
import { durableSignal } from "@habemus-papadum/aiui-viz";

export const sampleId = durableSignal("param:sampleId", "A1");
export const threshold = durableSignal("param:threshold", 0.5);
```

**`src/model/graph.ts` — the cells.** All of them, built inside one `hotCellGraph` call:

```ts
import { type Cell, cell, hotCellGraph } from "@habemus-papadum/aiui-viz";
import { sampleId, threshold } from "./store";

export interface AppGraph {
  spectrum: Cell<Spectrum>;
  peaks: Cell<Peak[]>;
}

export const graph = hotCellGraph<AppGraph>(
  "app",
  () => {
    const spectrum = cell(
      () => ({ id: sampleId.get() }),
      async (d, ctx) => fetchSpectrum(d.id, ctx.signal),
    );
    const peaks = cell(
      () => ({ spec: spectrum(), cutoff: threshold.get() }),
      (d) => findPeaks(d.spec, d.cutoff),
    );
    return { spectrum, peaks };
  },
  import.meta.hot, // ← always pass this, exactly like so
);
```

On a live edit of this file, `hotCellGraph` throws the old cells away and rebuilds them over the
surviving signals — parameters keep their values, every cell recomputes, the page never reloads.
The `import.meta.hot` at the end is the one incantation to accept on faith: it's a token that
identifies *this file* to the dev server, it must be written here (a library can't reach it for
you), and passing `undefined` — which is what happens automatically in a production build — just
turns hot-swapping off.

**`src/ui/` — the components.** They read cells through `graph()` and render them with `CellView`:

```tsx
import { graph } from "../model/graph";

export function PeakPanel() {
  return (
    <CellView of={graph().peaks} label="finding peaks">
      {(p) => <ol>{p().map((peak) => <li>{peak.energy} eV</li>)}</ol>}
    </CellView>
  );
}
```

Always `graph().peaks`, never a cell imported directly — the accessor is how a component keeps
pointing at the *current* graph across an edit. It never returns `undefined`, so no guard is
needed.

Two rules of thumb complete the picture: **new state goes in `store.ts`, new dataflow goes in
`graph.ts`**, and **don't edit `store.ts` or a `*.worker.ts` file mid-experiment** — those two are
the only edits that force a full page reload (the dev server cannot hot-swap a live worker or the
file everything grows from).

`npm create @habemus-papadum/aiui` scaffolds all of this working, with a placeholder app to
overwrite.

## Step 10: streaming — values that arrive in pieces

Return an async *generator* (note the `*`) and every `yield` publishes a value:

```ts
const catalog = cell(
  () => ({ attempt: attempt.get() }),
  async function* (deps, ctx) {
    let rows: Row[] = [];
    for (const url of pageUrls) {
      const page = await fetchPage(url, ctx.signal);
      if (ctx.signal.aborted) return;
      rows = [...rows, ...page];
      ctx.progress(rows.length / expectedTotal);
      yield rows; // ← publish what we have so far
    }
  },
);
```

A table rendering this cell fills in page by page — each `yield` is a real value that flows to
every consumer, chart included. Between yields the cell reports `streaming`, and `settled()` stays
false until the generator finishes.

Sometimes a consumer is too expensive to re-run on every partial — a fit that takes ten seconds
shouldn't restart per page. Two dials, one on each side:

- **On the producer:** `cell(deps, compute, { stream: "latest" })` — partials remain visible on
  `latest()` (and drive the progress stripe), but downstream cells see only the finished value,
  once.
- **On one consumer:** wrap the read in `settledOnly` —
  `deps: () => ({ rows: settledOnly(catalog) })` — and that consumer alone waits for completed
  runs while everyone else streams.

Both behaviors are pinned by unit tests in `cell.test.ts` ("latest mode" and "settledOnly"), which
double as runnable examples.

One rule for generators: **yield at least once** before finishing, or the cell errors — a stream
that ends silently with no value is treated as a bug, loudly.

## Step 11: heavy computation — Web Workers

When a computation is heavy enough to freeze the page, it belongs in a **Web Worker** — the
browser's way of running code on another core. The library reduces the ceremony to one function:

```ts
import { fromWorker } from "@habemus-papadum/aiui-viz";
import { analysisWorker } from "./store"; // the worker is durable — made once, in store.ts

const analysis = cell(
  () => {
    const grab = capture.get();
    if (!grab) return undefined;
    return { field: grab, cutoff: threshold.get() };
  },
  fromWorker<AnalysisParams, AnalysisResult>(analysisWorker),
);
```

Everything from the previous steps now composes: move the cutoff slider and the in-flight worker
run is *actually cancelled* (the worker receives a message and stops crunching), a new run starts,
partial results stream into the chart, and the stripe tracks progress. You wrote no message
plumbing.

Your side of the worker file speaks a four-message protocol — it receives
`{ id, type: "run", payload }` and `{ id, type: "cancel" }`, and posts back `progress`, `partial`,
`done`, or `error` (types exported as `WorkerRequest` / `WorkerReply`). Two hard-won rules for
writing it, each of which once cost a real debugging session:

- **Yield with a real timeout.** Between chunks, `await new Promise((r) => setTimeout(r, 0))` —
  not `await Promise.resolve()`. Only the former lets the `cancel` message be delivered; a worker
  that skips it is uncancellable in practice.
- **Don't send the final value as both a `partial` and the `done`.** Consumers that accumulate
  will count it twice.

The gallery demo's `analysis/` directory is a complete worked example, with the math kept in a
pure, separately-tested module — which is the worker-shaped version of Step 7's advice.

## Step 12: letting the agent drive

The last convention exists because an agent is part of the team: the app exposes its operations as
**tools** the agent can discover and call, instead of guessing at your UI. In `graph.ts`:

```ts
import { agentToolkit, registerStandardTools } from "@habemus-papadum/aiui-viz";

const kit = agentToolkit("app");
registerStandardTools(kit); // `locate` (screen → source) + the live cell table

kit.registerTool({
  name: "set-threshold",
  description: "Set the peak threshold. The slider follows; peaks recompute.",
  params: { value: "number 0..1" },
  run: (args) => {
    const v = Math.min(1, Math.max(0, Number(args?.value)));
    threshold.set(v);
    return { value: v }; // return what you wrote, not a re-read (see gotchas)
  },
});
```

Rule of thumb: **every operation a user can perform gets a tool twin.** It costs a few lines and it
is how the agent verifies its own work — set a parameter, read the report, check the cell states —
rather than squinting at screenshots.

## Gotchas that bite exactly once

Collected here so they bite zero times. The first two you have already met; the rest come from the
underlying UI library (SolidJS 2.0) and are the kind of thing no one should have to remember — so
they're written down. The full ledger, with the debugging stories, is
[Hard-won details](./frontend-hard-won).

- **Deps and compute drifting apart** (Step 3). Everything `compute` uses arrives via the bundle.
  Test each input.
- **A boolean dependency closes the gate** (Step 6). Box it.
- **Reads right after writes see the old value.** Writes are batched into transactions:
  `threshold.set(0.7); threshold.get()` in the same instant returns the *old* value. Where it
  bites: a tool that sets then re-reads (return what you computed instead), and tests (await a
  `tick()` after every `set`).
- **Don't `set` a signal from inside a cell's compute** (before its first `await`). The dev build
  throws `REACTIVE_WRITE_IN_OWNED_SCOPE`. State changes belong in event handlers and tools; if a
  compute truly must flag something, defer it: `queueMicrotask(() => flag.set(true))`.
- **`myCell()` throws when the cell isn't ready.** Fine inside `deps` and `CellView`; everywhere
  else, `myCell.latest()`.
- **An errored cell shows the error box even though `latest()` still has a value.** Errors win —
  by design, so failures aren't papered over. The Retry button calls `refetch()`.
- **`<Show>`'s function child gets an accessor,** like `CellView`'s: `{(v) => v().thing}`.
- **The name stamps need the plugin.** `data-cell` attributes and the cell registry are injected
  at compile time by `aiuiDevOverlay({ locator: { cellFactories: ["cell"] } })` in
  `vite.config.ts`. The scaffold has it; if names come up `undefined`, that's what's missing.

## A young library

`@habemus-papadum/aiui-viz` is early and deliberately small. If you — or the agent working with
you — hit a pattern the library almost supports, the right move is usually to **improve the
library**, not to work around it in app code: add the missing helper, write the unit test that
pins its behavior (`cell.test.ts` is the model), and leave the app simpler than you found it. Twice
now, boilerplate that every app copied has been folded into one tested call (`hotCellGraph`,
`registerStandardTools`); assume there is more of that to find, and don't treat the library as a
frozen artifact.

## Where to go next

- **Do:** `npm create @habemus-papadum/aiui my-app` — the starter with this whole shape working.
- **Read:** `demos/gallery` — three real notebooks (GPU simulation, worker pipeline, DuckDB
  crossfilter) built from nothing but these steps.
- **Deeper:** [Concepts](./frontend-for-agents) · [Design choices](./frontend-design-choices) ·
  [Hard-won details](./frontend-hard-won) ·
  [Attribution: gesture → source](./attribution) (how "make *this* wider" finds your code) · the
  [`aiui-viz` API reference](/packages/aiui-viz/).
