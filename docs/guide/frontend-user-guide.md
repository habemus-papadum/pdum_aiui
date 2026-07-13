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
need none of them to use this one. When you're past learning the pieces and are building a whole
app, the [Playbook](./frontend-playbook) sequences the work — pure functions, then cells, then
components, then the application — with a definition of done per layer.

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
live code edit — more on that in [Step 10](#step-10-where-everything-lives), and until then you can
ignore it. The string key just names the box.

## Step 2: the control surface — the knobs of your experiment

A bare signal is anonymous plumbing. The knobs a *person* turns — and an agent should be able to
turn — deserve more: a name, a description, legal bounds. Declare those with `control()`:

```ts
import { control } from "@habemus-papadum/aiui-viz";

/** Diffusion constant — how fast heat spreads down the rod. */
export const kappa = control({ value: 0.1, min: 0.01, max: 1, step: 0.01 });
```

Notice what you did NOT write: no name, no description string. The aiui compiler injects the name
from the variable (`kappa`) and lifts the doc comment as the description — so the comment you'd
write anyway becomes the editor tooltip *and* what the agent reads. Write real doc comments.

What the declaration buys, everywhere at once:

- **One source of truth for constraints.** Every write — a slider, a keyboard shortcut, the
  agent — is validated by the same declaration: numbers clamp to `min`/`max` and snap to `step`;
  a control with `options: [...]` (an enum) rejects anything else; wrong types throw.
- **Widgets for free-ish.** `<ControlSlider of={kappa} />` renders a slider whose bounds, step,
  and unit come from the declaration (never re-type them in the UI); `<ControlToggle of={flag} />`
  does booleans. These are ordinary components you compose into your own layout — there is
  deliberately no auto-generated panel.
- **Agent access, with zero extra code** — Step 13 shows the derived tools.
- **Durability**: like `durableSignal`, a control survives live code edits. One consequence to
  know: the name is the storage key, so *renaming the variable resets the stored value* — pass an
  explicit `{ name: "kappa" }` to rename the binding without that.

Controls have the same `.get()`/`.set()` interface as signals, so everything in the following
steps applies to them unchanged. And not every signal should be a control: transient interior
state stays a plain signal — the surface is *curated*, which is exactly what makes it useful.

Verbs get the same treatment as values. An operation that isn't "set a value" — re-seed the
noise, capture a snapshot — is an **action**:

```ts
/** New random seed; the profile recomputes. */
action({ name: "re-seed", run: () => seed.set((s) => s + 1) });
```

## Step 3: your first cell

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
that bundle and returns the value. Keep that division of labor in mind; Step 4 explains why it
matters more than it looks.

## Step 4: how the cell knows when to re-run

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
an easy one to drift from during a refactor — which is why [Step 8](#step-8-testing-your-cells)
shows a unit test that catches exactly this, and why an agent writing cells should write that test
without being asked.

## Step 5: putting a cell on screen

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

## Step 6: cells that use other cells

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
is in [Step 9](#step-9-progress-and-cancelling).

## Step 7: the gate — "don't run yet"

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

The gate is also how you'll cancel things, in [Step 9](#step-9-progress-and-cancelling).

## Step 8: testing your cells

A cell graph is plain model code — no browser, no rendering. That makes it *unit-testable*, and
testing is not optional decoration here: it is the counterweight to the deps magic in Step 4. A
test that moves each input and watches the output is exactly the instrument that catches a
dependency the code forgot to declare.

The library ships a harness for exactly this — `@habemus-papadum/aiui-viz/testing` — which hides
the reactive plumbing a raw test would need (owners, write batching, tick counting). A test reads
as intent:

```ts
import { cellHarness, whenReady } from "@habemus-papadum/aiui-viz/testing";
import { afterEach, describe, expect, it } from "vitest";

describe("the peaks cell", () => {
  let h: ReturnType<typeof cellHarness<AppGraph>>;
  afterEach(() => h.dispose());

  it("recomputes when the threshold moves", async () => {
    h = cellHarness(() => buildGraph()); // your graph.ts build function

    const before = await whenReady(h.cells.peaks);
    threshold.set(0.9); // move ONE input…
    expect(await whenReady(h.cells.peaks)).not.toEqual(before); // …it noticed ✓
  });
});
```

Four helpers cover almost every dataflow test:

- **`cellHarness(setup)`** — builds the graph under a disposable owner and keeps every returned
  cell live, the way a rendering app would.
- **`whenReady(cell)`** — waits for the next settled value and returns it; if the run *fails*, it
  rejects with the compute's error rather than a useless timeout.
- **`whenState(cell, "held")`** — waits for any state; this is how a test observes the cancel
  gesture from [Step 9](#step-9-progress-and-cancelling).
- **`recordCommits(cell)`** — collects every value a streaming cell publishes, so
  [Step 11](#step-11-streaming--values-that-arrive-in-pieces)'s "three partials or one settled
  value?" is a one-line assertion.

The library's own suites are the worked examples: `testing.test.ts` shows each helper in use
(including the out-of-sync bug caught by a per-input probe), and `cell.test.ts` keeps the raw,
harness-free patterns for when you need to see the machinery.

If you (or your agent) write a cell with more than one input, write the test that moves *each*
input — controls included. It is three lines per input and it converts the framework's one silent
failure mode into a loud one.

Three rules keep these tests honest:

- **Build cells inside the harness's callback.** A cell created at module top level or in the
  test body has no reactive owner and throws `NO_OWNER_BOUNDARY`; the setup callback is the
  owner.
- **`resetControlSurface()` in `afterEach`.** Controls are shared state across a test file
  (modules import once); the reset restores every control to its declared initial and clears the
  recorded dependency edges, while keeping the registrations alive for the next test.
- **The compiler runs under Vitest too.** Control names and descriptions are injected at compile
  time, so the same plugin from `vite.config.ts` belongs in `vitest.config.ts` — the scaffold
  ships it wired. Without it, controls come out nameless and tests fail confusingly.

## Step 9: progress, and cancelling

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
the gate from Step 7: cancelling *is* closing the gate.

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
| `streaming` | producing partial values right now (Step 11) |
| `refreshing` | has a value; a newer one is on the way |
| `held` | has a value; gate closed — idle, at rest |
| `ready` | has a settled value |
| `errored` | the run threw; `error()` has it, `latest()` still serves the old value |

## Step 10: where everything lives

Here is the part where we ask you to copy a shape without fully deriving it. The payoff is **hot
reload that never loses your work**: you (or the agent) edit code while a simulation runs, and the
simulation, the slider positions, and the history all survive the edit. Every aiui app is split
into three files to make that true:

**`src/model/store.ts` — things that survive edits, and the control surface.** Your knobs are the
`control()` declarations from Step 2; internal state is `durableSignal`; non-signal resources
(workers, engines, canvases) are `durable(key, create)`. All of them are *re-found*, not
re-created, on a live edit — the slider the user positioned stays put.

```ts
import { control, durableSignal } from "@habemus-papadum/aiui-viz";

/** Which sample the instruments read. */
export const sampleId = control({ value: "A1", options: ["A1", "A2", "B1"] });

/** Peak-detection cutoff. */
export const threshold = control({ value: 0.5, min: 0, max: 1, step: 0.01 });

// internal, not a knob — the surface is curated
export const lastFetchAt = durableSignal("lastFetchAt", 0);
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

## Step 11: streaming — values that arrive in pieces

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

## Step 12: heavy computation — Web Workers

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
pure, separately-tested module — which is the worker-shaped version of Step 8's advice.

## Step 13: letting the agent drive

The last convention exists because an agent is part of the team: the app exposes its operations as
**tools** the agent can discover and call, instead of guessing at your UI. And here Step 2 pays
off completely — you already wrote the tools, by declaring the surface. In `graph.ts`:

```ts
import { agentToolkit, registerStandardTools } from "@habemus-papadum/aiui-viz";

const kit = agentToolkit("app");
registerStandardTools(kit);
```

Those two lines derive the whole standard surface from your declarations:

- **`report`** — one bounded snapshot of the app: every control (value; the `full` format adds
  bounds, description, definition site), every cell and its state, every action, and the
  **dependency edges** — which cells actually read which controls, recorded live as they run.
  This is the single most-used call in agent-driven verification.
- **`set`** — writes any control by name, through the same validation as the slider (clamped,
  snapped, enum-checked), and returns what was *actually* written.
- **One real tool per `action()`** — the `re-seed` you declared in Step 2 is now a tool named
  `re-seed`, description included.
- **`locate`** — screen element → source location, for "make *this* wider."

Rule of thumb: **don't write tools — declare controls and actions.** The hand-written
set-this/get-that tool this framework once required is gone; `kit.registerTool` remains only for
the genuinely bespoke operation (a database query, say). Declaring is exposing — and it is how
the agent verifies its own work: `set` a parameter, read the `report`, check the cell states —
rather than squinting at screenshots.

## Gotchas that bite exactly once

Collected here so they bite zero times. The first two you have already met; the rest come from the
underlying UI library (SolidJS 2.0) and are the kind of thing no one should have to remember — so
they're written down. The full ledger, with the debugging stories, is
[Hard-won details](./frontend-hard-won).

- **Deps and compute drifting apart** (Step 4). Everything `compute` uses arrives via the bundle.
  Test each input.
- **A boolean dependency closes the gate** (Step 7). Box it.
- **Reads right after writes see the old value — everywhere, not just in tools and tests.**
  Writes are batched into transactions: the commit happens at the next microtask, and only code
  running *inside* the reactive graph (memo computes, effect computes, JSX, cell `deps`) sees
  staged values — those reads are always fine, which is why pure-dataflow code never hits this.
  Any plain callback that sets then re-reads gets the pre-write answer:
  `threshold.set(0.7); threshold.get()` returns the *old* value, and a **derived** read (a memo
  over the value just written) is exactly as stale. Don't read back — branch on the value you
  computed or the setter's return. A flow that genuinely must observe its own writes (a
  state-machine dispatch) calls `flush()` from `solid-js`, which commits synchronously
  (`flush(fn)` runs effect handlers too). In tests, `await tick()` after every `set` also works.
- **Don't `set` a signal from inside a cell's compute** (before its first `await`). The dev build
  throws `REACTIVE_WRITE_IN_OWNED_SCOPE`. State changes belong in event handlers and tools; if a
  compute truly must flag something, defer it: `queueMicrotask(() => flag.set(true))`.
- **`myCell()` throws when the cell isn't ready.** Fine inside `deps` and `CellView`; everywhere
  else, `myCell.latest()`.
- **An errored cell shows the error box even though `latest()` still has a value.** Errors win —
  by design, so failures aren't papered over. The Retry button calls `refetch()`.
- **`<Show>`'s function child gets an accessor,** like `CellView`'s: `{(v) => v().thing}`.
- **Renaming a control's variable resets its stored value.** The injected name is the durable
  storage key. To rename the binding without losing state, pass an explicit `{ name: "old-name" }`
  (Step 2).
- **Never re-type a control's bounds in the UI.** `min`/`max`/`step` in a slider's JSX will
  silently drift from the declaration; `<ControlSlider of={c} />` reads them from the control.
- **The name stamps need the plugin.** Cell and control names, descriptions, and the registry
  are injected at compile time by `aiuiDevOverlay({ locator: true })` in `vite.config.ts` (and
  the same plugin in `vitest.config.ts`). The scaffold has both; if names come up `undefined`,
  that's what's missing.

## A young library

`@habemus-papadum/aiui-viz` is early and deliberately small. If you — or the agent working with
you — hit a pattern the library almost supports, the right move is usually to **improve the
library**, not to work around it in app code: add the missing helper, write the unit test that
pins its behavior (`cell.test.ts` is the model), and leave the app simpler than you found it. Twice
now, boilerplate that every app copied has been folded into one tested call (`hotCellGraph`,
`registerStandardTools`); assume there is more of that to find, and don't treat the library as a
frozen artifact.

## Advanced: composing bigger apps — slices and scopes

Everything above assumes one app, written in one place. Sooner or later you'll want to **reuse a
piece** — the same instrument in two applications, or the same instrument *twice on one page*.
This section is the how; skip it until you need it.

**The unit of reuse is a pair of factory functions, not a graph object.** A graph is not a thing
with membership — `hotCellGraph` provides an owner and whatever your build function returns *is*
the graph. So a reusable "slice" is just:

```ts
// a library module (its own package, or a shared folder)
export function oscillatorStore(s: Scope) {
  /** Natural frequency, Hz. */
  const freq = control({ scope: s, value: 1, min: 0.1, max: 5, step: 0.1 });
  const phase = s.durableSignal("phase", 0); // internal state, scoped key
  /** Kick the oscillator: a quarter-turn phase impulse. */
  const kick = action({ scope: s, name: "kick", run: () => phase.set((p) => p + Math.PI / 2) });
  return { freq, phase, kick };
}

export function oscillatorCells(s: Scope, store: ReturnType<typeof oscillatorStore>) {
  /** The sampled displacement trace. */
  const trace = cell(() => ({ f: store.freq.get(), p: store.phase.get() }), computeTrace, {
    scope: s,
  });
  return { trace };
}
```

The store factory is called once per instance at module level (durable side); the cells factory
is called inside the app's one `hotCellGraph` build (disposable side). A slice never owns the
`hotCellGraph` ritual — that belongs to the app module holding `import.meta.hot`.

**The `scope` is what makes two instances possible.** Without it, both instances come from the
same call site, get the same compiler-injected name, and silently share one durable state — the
registry can't tell "second instance" from "hot re-evaluation". With it:

```ts
// the app's store.ts
export const left = oscillatorStore(scope("left"));
export const right = oscillatorStore(scope("right"));
```

each instance's identity is qualified everywhere at once: controls `left/freq` and `right/freq`
with separate durable state, agent tools `left/kick` and `right/kick`, cells `left/trace`, and
dependency edges that point at the right instance's controls. The compiler still injects the
*leaf* name and the description from the doc comment — the scope is a runtime qualifier you
thread through explicitly, the same way you thread a worker or any other dependency (there is
deliberately no ambient "current scope"). Scopes nest (`scope("rig").child("left")`) for slices
that instantiate sub-slices.

Composing across instances is nothing special — a cell that reads both:

```ts
const lissajous = cell(() => ({ x: leftCells.trace(), y: rightCells.trace() }), interleave);
```

**Where the slice's names and descriptions come from** depends on who compiles it:

- **In a workspace** (the slice is a linked package the app imports source-first): the app's own
  compiler processes it — names, descriptions, and dotdot-relative definition sites
  (`../../packages/spectra/src/store.ts:12`) come for free.
- **As a published library**: run the compiler in the library's own build and tests
  (`sourceLocatorVite({ locPrefix: "@you/spectra/" })` in its vite/vitest config), so the dist
  carries baked, package-qualified identity. Or write explicit `{ name }`s and descriptions —
  the un-ergonomic fallback.

The living reference is `packages/aiui-oscillator` (the slice, with its own compiled identity
and tests) consumed twice by `demos/twins` (two scoped instruments composed into a Lissajous
figure — call `__app.call("report")` there to see a qualified surface).

## Where to go next

- **Do:** `npm create @habemus-papadum/aiui my-app` — the starter with this whole shape working,
  its example tests included. Its placeholder rose is fenced with `<aiui-scenery>` markers: ask
  any model to follow the starter `CLAUDE.md`'s three-step reset and you have a blank canvas.
- **Build:** the [Playbook](./frontend-playbook) — the four-layer order of construction for a
  real analytic app, with each layer's testing story.
- **Watch it built:** `demos/walkthrough` — the playbook executed step by step on one small app
  (1-D heat diffusion), with every stage left standing as its own page and a narration of each
  diff (`WALKTHROUGH.md`).
- **Read:** `demos/gallery` — three real notebooks (GPU simulation, worker pipeline, DuckDB
  crossfilter) built from nothing but these steps.
- **Deeper:** [Concepts](./frontend-for-agents) · [Design choices](./frontend-design-choices) ·
  [Hard-won details](./frontend-hard-won) ·
  [Attribution: gesture → source](./attribution) (how "make *this* wider" finds your code) · the
  [`aiui-viz` API reference](/packages/aiui-viz/).
