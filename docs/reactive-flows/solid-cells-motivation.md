# Observable-style async cells in SolidJS — motivation and findings

## The original ask (cleaned up)

I do a lot of high-iteration scientific and quantitative visualization: drag a slider, refit a model, redraw a chart, repeat hundreds of times a session. The environment that gets the *interaction model* right for this is the Observable notebook. In Observable, every computation is a node in a reactive dataflow graph. A cell automatically waits until its inputs are available, re-runs when any input changes, and shows a pending state while it works — and because inputs can be async, that pending state propagates through the whole graph without me wiring it up.

What I wanted was that **value-level async dataflow model**, but in a real production framework with real TypeScript — not the notebook itself. Concretely: a small "cell" primitive where each node carries its own pending / error / progress state; where a downstream computation holds until its inputs are ready; where changing a parameter aborts the now-stale in-flight run instead of racing it; where a long computation can stream partial results; and where the UI keeps showing the last good chart (dimmed, with a progress hint) while the next one computes, rather than blanking out on every tweak. I chose SolidJS as the target because its fine-grained reactivity is the closest match, and I wanted the result as a self-contained artifact I could carry into other projects and hand to a coding agent.

## Why this is the right shape of problem

The core insight is that most UI frameworks track *synchronous* dependencies well and *asynchronous* ones badly. The moment a value becomes a promise, the automatic "wait for my inputs, then recompute" guarantee breaks, and you end up hand-managing loading flags, race conditions, and cancellation at every call site. Observable's contribution was never the notebook UI — it was making async a first-class citizen of the dependency graph. Reproducing that as a tiny library, rather than adopting a heavyweight data-fetching stack, keeps full control over the things that matter for iterative numerical work: cancellation via `AbortSignal`, progress reporting, streaming partials, and precise TypeScript inference. Caching and request deduplication are deliberately *out* of scope; that is a solved problem better delegated to a query library feeding results in as plain inputs.

## The findings

**SolidJS is the right substrate, and version 2.0 validates the entire approach.** The most useful result of this exercise is not the library itself but what building it twice revealed about where the framework is going.

On SolidJS 1.x, the concept works and is genuinely useful, but it takes a real layer of custom machinery — roughly 150 lines — to gate computations on readiness, keep stale values visible, abort superseded runs, and expose a clean state machine. You are building the async-dataflow semantics on top of a framework that only partly supports them.

On SolidJS 2.0 (in beta as of mid-2026), the framework itself **absorbed most of what the library had to do by hand.** Async is now first-class in the reactive core: a computation can return a promise or an async iterable directly; each streamed value propagates through the graph in real time; reading a not-yet-ready value automatically suspends whatever depends on it, so downstream nodes hold with no explicit gating; parallel dependency paths stay transactionally consistent (no glitches where one branch shows new data and another shows old); stale values are served while new work is pending; and a superseded run is discarded with its cleanup fired. In other words, the thing I was reaching for is becoming the framework's native model rather than a pattern layered on top.

That reframes what a "cell" is *for* on 2.0. It shrinks from a dataflow engine to a thin ergonomic layer over one that already exists — the parts the framework still leaves to the application: an `AbortSignal` per run so fetches and workers actually stop; progress reporting; a reliable "this run has finished" signal (the framework treats every partial as a real value, so it can't tell you a stream is *done*); non-throwing status accessors for building UI; and a retry affordance. The most telling single detail: the 1.x library needed a helper to combine several async inputs and wait for all of them; on 2.0 that helper is *gone*, because you simply read your inputs and holding happens for free.

**The practical conclusion.** The bet on Solid was correct, and it is getting stronger over time: rather than the framework and this pattern drifting apart, 2.0 moved decisively toward exactly this async-dataflow model. For high-iteration analytical UIs, that means less bespoke plumbing and more of the "wait for inputs, stream, stay responsive" behavior coming from the platform. The accompanying technical documents give the full implementation for each version; this note is just the why.

## Desideratum: a `redefine` primitive — hot-swapping a cell's compute in place

One capability belongs on the "what a cell still adds over raw framework reactivity" list above, and the current API does not yet expose it: the ability to **replace a cell's `compute` (and `deps`) function while preserving the cell's identity, its cached last-good value, and its downstream edges**. This is a *definite* desideratum, not a maybe — it is what makes a cell graph survive hot module reloading, and HMR is the substrate of the agentic pairing loop (see [`../agentic_ui_workflow/hmr_for_agentic_coding.md`](../agentic_ui_workflow/hmr_for_agentic_coding.md)).

The motivation is a clean reframe: **a code edit is just another cause of invalidation.** When an input changes, a cell already aborts the stale in-flight run via `ctx.signal`, keeps serving the last committed value (dimmed, with progress) so the UI never blanks, re-runs, and lets dependents hold and recompute. An edit to the cell's *compute function* wants the identical treatment — the only difference is *what* changed. Today `refresh(memo)` re-runs the **same** compute; what HMR needs is to swap the compute to a **new** function and then invalidate, reusing every bit of that supersession machinery. Without it, an HMR update has to reconstruct the cell from scratch, discarding the cached value and the reproduced state the human worked to establish.

### How it might look

The point of leverage is the same "mutable facade" trick this codebase already uses elsewhere (the observability logger swaps its backing logger under a stable reference; a cell would swap its backing compute under a stable memo). Rough shape — a sketch, not a spec:

```ts
interface Cell<T> {
  // …existing state()/latest()/error()/refresh()/refetch()…
  /** Swap this cell's compute (and optionally deps) in place, then invalidate.
   *  Identity, cached last-good value, and downstream edges are preserved; the
   *  in-flight run (if any) is superseded exactly as an input change would supersede it. */
  redefine(compute: Compute<T>, deps?: Deps): void;
}
```

Internally this leans on an indirection the cell would already have to introduce: rather than closing `createMemo` over a fixed `compute`, close it over a mutable ref —

```ts
let currentCompute = compute;                       // the swappable box
const memo = createMemo((prev) => currentCompute(ctx, prev));
function redefine(next: Compute<T>) {
  currentCompute = next;
  refresh(memo);   // re-run through the existing invalidation path
}
```

Two properties fall out of Solid 2.0's model and are worth stating:

- **Deps re-track for free.** Because tracking is dynamic per run, a new compute that reads *different* inputs re-establishes its dependency edges on the next run — no manual graph surgery. Swapping `deps` is mostly a matter of re-reading them.
- **A superseded stream finalizes cleanly.** If the cell is mid-`yield` on an async iterable when redefined, supersession fires the abort signal and runs the generator's `finally` once its in-flight `await` settles — the same path documented for an input-driven supersession. Redefine gets that behavior at no extra cost.

### Open edges

- **Identity across structural edits.** `redefine` preserves state only when the HMR layer can match "the new version of this cell" to the existing one — which needs stable, addressable cell identity (a name/key), not positional identity. Renames and splits are the hard case; an agent doing the edit could *emit* the old→new mapping as part of the edit, which a human HMR setup never could.
- **Shape changes.** If the new compute returns a value whose *shape* is incompatible with what downstream consumers or the cached value assume, a silent swap is worse than a reset. Redefine should pair with a "this edit is not hot-safe → fail loud and force a clean reload" escape hatch, as the HMR doc argues.
- **Cancel-and-restart vs. let-it-finish.** When redefine hits a long run, aborting-and-restarting is the default the supersession machinery gives you, but "let the old run finish, apply the new compute to the next run" is sometimes what you want. Likely a per-cell policy.

These are first thoughts on the *why* and a plausible shape; the concrete slot in `cell.ts` and the calls left open are sketched at the end of the v2 technical document. Treat both as a starting point to build on, not a spec to follow.
