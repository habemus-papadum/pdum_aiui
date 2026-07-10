# The playbook, worked: heat in a rod

This demo builds one small scientific app — 1-D heat diffusion — in exactly the order the
[frontend playbook](../../docs/guide/frontend-playbook.md) prescribes, and **leaves every stage
standing as its own page** so you can diff the layers:

| page | layer | what exists |
| --- | --- | --- |
| [`/step1.html`](./step1.html) | 1 · pure functions | the math, rendered statically |
| [`/step2.html`](./step2.html) | 2 · controls + cells | a live, steerable, agent-drivable instrument — crude on purpose |
| [`/step3.html`](./step3.html) | 3 · components | the same cells, worn well |
| [`/`](./index.html) | 4 · application | sections, prose, keys |

Run it: `pnpm -C demos/walkthrough dev` (or through the full loop with
`pnpm -C demos/walkthrough claude` in another terminal).

## Step 1 — pure functions (`src/lib/diffusion.ts`)

Everything *about the domain* and nothing else: initial profiles, one FTCS step, the stability
limit, the analytic gaussian, error norms. Realm-free — no framework, no `window`, no time — so
the same functions run on the page, in the worker, and under Vitest.

The discipline that goes with the code:

- `diffusion.test.ts` pins the physics: walls stay cold, maxima never grow, symmetry is
  preserved, the scheme **blows up past r = ½** (tested by blowing it up), the march tracks the
  analytic reference, refining the grid shrinks the error.
- `diffusion.bench.ts` produced the number that decided layer 2's big question: a full evolution
  at high resolution costs ~0.1–1 s — too long for the main thread, short enough that a chunked
  worker feels instant. **Measure, then decide.**

Diff to step 2: nothing here changes — layer 1 is a dependency of everything and a consumer of
nothing.

## Step 2 — the control surface and the cells (`src/model/`)

Two declarations turn the math into an instrument:

**`store.ts` — the independent variables.** Each knob is a `control()`: value, constraints, and a
doc comment that the aiui compiler lifts into the registry description (names and definition
sites are injected too — nothing is hand-annotated). Curation is the point: `seed` stays a plain
`durableSignal` because it is derived state the `re-seed` action bumps, not a knob.

**`graph.ts` — the derived variables.** The `evolution` cell points at the worker with
`fromWorker`; `profile` and `errors` derive from it. Reality lives here and only here: drag κ
mid-run and supersession cancels the in-flight march (the worker really stops — the macrotask
yield in `diffusion.worker.ts` is what makes that true); partial frames stream in; `errors`
**holds** when the IC has no analytic reference, and CellView shows the held state honestly.

The part that needs no code at all: `report` / `set` / the `re-seed` tool exist because the
declarations exist. Open the console on step 2 and drive the app exactly as an agent would:

```js
__walkthrough.call("report")                      // controls, cells, actions, EDGES
__walkthrough.call("set", { name: "kappa", value: 0.8 })
__walkthrough.call("re-seed")
```

The `edges` section of that report is the dependency topology, recorded live from each cell's
deps — `evolution ← kappa, points, ic, simTime`; `errors ← ic, profile, kappa, points`.

The tests (`graph.test.ts`) run the whole thing headless with a **stub worker** — jsdom has no
`Worker`, so `buildGraph(worker)` takes the worker as a parameter and the test hands it a
30-line protocol shell over the same layer-1 math. One `whenReady` probe per control, streaming
pinned with `recordCommits`, the hold observed with `whenState`.

Diff to step 3: zero model changes. That is the claim being demonstrated.

## Step 3 — designed components (`src/ui/`)

Pure readers, one discipline: cells in (through `graph()`), markup out.

- `ProfileChart` — SVG polyline plus the dashed analytic overlay.
- `SpaceTimeMap` — the run as a heatmap; the canvas is an imperative island behind a
  `createEffect(source, handler)` bridge (track in the source, paint in the handler — never read
  signals in the handler).
- `ErrorReadout` — CellView over the gated cell; the fallback *names* why there is nothing to
  show instead of pretending to load.
- `Controls` — `ControlSlider`s (bounds from each control's meta — declared once, shared with the
  agent's `set`) and a hand-rolled `<select>` for the enum control: the porcelain doesn't cover
  selects yet, and hand-rolling is how a `ControlSelect` earns its extraction evidence.

Diff to the finished page: components don't change either.

## The finished page (`src/main.tsx`, `src/model/keys.ts`)

Layer 4 is arrangement: paper-style sections with the controls inside the prose, an experiments
list naming exact controls, and a keyboard layer on the modal kit — <kbd>R</kbd> dispatches the
**same registered `re-seed` action** the agent calls, <kbd>←</kbd><kbd>→</kbd> nudge κ through
the **same validated control** the slider writes, and the hint bar is derived from the bindings
themselves. One declared surface; widget, keyboard, and agent are three views of it.
