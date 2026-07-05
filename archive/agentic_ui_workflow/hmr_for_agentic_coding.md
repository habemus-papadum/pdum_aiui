# HMR for agentic coding

Hot module reloading is usually sold as a convenience: save a file, see the change, keep your scroll
position. In an **agentic UI workflow** it is something stronger — it is the substrate that makes the
whole pairing loop viable. This doc lays out what "good" should look like, starting from desiderata
rather than a mechanism, and then sketches the concrete shapes that fall out — several of which the
reactive **cell** model in [`../reactive-flows/`](../reactive-flows/) already hands us for free.

It is a companion to [`agentic_frontend_debugging.md`](agentic_frontend_debugging.md) (the pairing
loop that depends on HMR) and [`agent_observable_web_workers.md`](agent_observable_web_workers.md)
(the durable `window.__<ns>` handle, which is the same idea applied to observability).

---

## Why HMR matters *more* when an agent is in the loop

In solo human development, a reload that resets state costs you a few seconds and a mild annoyance.
In an agentic loop the economics invert, for three reasons:

1. **The human's established state is the expensive input.** The loop is: the human drives the UI
   into a hard-to-reach state (a connection open, a dataset loaded, a specific view navigated to, a
   race reproduced), then the agent edits code to probe or fix it. That reproduced state is the most
   valuable and least reproducible thing in the session. A reload that discards it makes the human
   redo the expensive part on *every* iteration — and the agent iterates a lot.

2. **Things take a long time.** Scientific and streaming UIs run 30-second fits, long simulations,
   large fetches, slow worker warmups. If each edit cancels and restarts that work, the agent's
   iteration cadence is bounded by the *computation*, not the edit — the exact opposite of what fast
   feedback is for.

3. **A reset can hide the bug.** Worse than slow: a reload can erase the very state that was causing
   or masking the failure. "It went away when I reloaded" is not a fix; it is a lost repro. HMR that
   preserves state keeps the bug *pinned* while the agent works on it.

So the goal is sharper than "fast reload." It is: **an edit to logic must not destroy the runtime
state the loop is built on.**

---

## The core reframe: an edit is just another cause of invalidation

The reactive cell model already solves a problem that is structurally identical to HMR. When an input
to a cell changes, the framework: aborts the now-stale in-flight run (via `AbortSignal`), keeps
serving the **last good value** (dimmed, with a progress hint) so the UI never blanks, recomputes the
cell, and lets that propagate to dependents that hold until it settles. (See
[`../reactive-flows/solid-cells-motivation.md`](../reactive-flows/solid-cells-motivation.md).)

A code edit wants *exactly the same treatment*, with one substitution: the thing that changed is the
cell's **compute function**, not its inputs. Everything else is the same — abort the stale run, keep
the last good value on screen, re-run, let dependents hold and recompute.

> **HMR is supersession triggered by an edit instead of an input change.**

That reframe is the whole thesis. A codebase built as a graph of cells over durable roots doesn't
need a bespoke HMR strategy; it needs HMR to *route an edit into the invalidation machinery the graph
already has*. Where code is instead a pile of module-level singletons, listeners, and timers, HMR has
nothing to hook into and every edit is a coin flip between "reset everything" and "leak a duplicate."

---

## Desiderata — what good looks like

Start here. These are the properties to design toward; the mechanisms in the next section are one way
to get them, not the only way.

1. **State survives code edits by default.** Editing a function body does not return the app to its
   initial state. The connection stays open, the data stays loaded, the reproduced view stays
   reproduced. Preservation is the default; loss is the exception you opt into deliberately.

2. **A bright line between *durable state* and *disposable logic*.** Some things must persist across
   an edit — open resources (sockets, workers), accumulated data, subscriptions, the log ring buffer,
   and above all the human's interaction state (form contents, selection, route, scroll). Other
   things are cheap and should be recreated fresh — pure render functions, derived computations, event
   handler bodies. Good design makes this line explicit in the code's *shape*, so HMR can preserve one
   side and swap the other without guessing.

3. **Derived state is always recomputable from durable roots.** If everything ephemeral can be
   reconstructed by re-running pure logic over the durable roots, HMR is safe by construction:
   preserve the roots, swap the logic, recompute the rest. This is the reactive-graph guarantee, and
   it is what makes edits cheap. Hidden state that *can't* be re-derived (a mutation buried in a
   closure, an accumulator with no source of truth) is what makes edits dangerous.

4. **Setup is idempotent — no double-mount, ever.** Re-evaluating a module must never create a second
   socket, a second worker, a second interval, or a second listener. The single hardest HMR bug is
   the leaked duplicate: an old worker still running while a new one starts, two subscriptions firing
   for one event. Setup must *adopt* an existing resource if present and create only if absent.

5. **Dispose runs, and disposes exactly the right amount.** The reload hook must tear down precisely
   what the new module will recreate — no less (or you leak), no more (don't kill the connection the
   new code means to keep). "Exactly what will be recreated" is the invariant.

6. **The human's interaction state is treated as most precious of all.** Of everything durable, what
   the human *did* — typed, selected, scrolled, navigated, reproduced — is the costliest to recreate
   and the easiest to lose. It should survive edits even when other durable state is legitimately
   rebuilt.

7. **In-flight work is cancellable and survives unrelated edits.** A long computation must not be
   aborted by an edit to code it doesn't depend on (editing a render function must not kill a running
   worker fit). When an edit *does* touch the running computation, superseding it should be clean —
   abort via signal, keep the last good value visible, restart — not a hang or a leak.

8. **Unsafe reloads fail loud, never silently corrupt.** Some edits change the *shape* of durable
   state — a field added to the in-memory model, a message protocol version bumped. Silently
   hot-swapping code onto stale-shaped state produces a Frankenstein worse than a clean reload. The
   system should detect "this edit is not hot-safe," and either migrate explicitly or force a full
   reload **with a logged reason**. A visible, explained reset beats an invisible corruption.

9. **The reload is observable.** When HMR applies, it should say what it did:
   `[app:hmr] swapped pipeline · preserved connection + 42 queued items · recomputed 3 cells`. The
   agent needs to know what survived and what reset — otherwise a bug might actually be "the edit
   discarded the state that mattered," and neither human nor agent can see that. An HMR event that
   names what it preserved and discarded is itself instrumentation, in the exact spirit of the
   observability docs.

10. **Identity is stable and addressable across edits.** HMR can only match "the new version of this
    thing" to "the old thing's state" if the thing has a stable identity — a named cell, a keyed
    resource, a registry handle. Anonymous, positionally-identified closures can't be matched across
    an edit, so their state can't be preserved. Name what must survive.

---

## Concrete shapes that deliver these

Offered as starting points. Several are just the cell model and the `window.__<ns>` registry pattern,
pointed at the HMR problem.

### The cell is the natural unit of hot-swap

A cell already separates the three things HMR needs to treat differently:

- **identity** (which cell this is) — stable, addressable;
- **cached last-good value + state** — the durable part, kept on screen while pending;
- **the compute function** — the disposable part, the thing an edit changes.

So the HMR handler for a module of cells shouldn't re-run the module top-to-bottom (which would
reconstruct every cell from scratch and lose the cache). It should call, per cell, something like
`cell.redefine(newCompute)` — swap the compute, mark the cell stale, let the graph recompute
downstream — reusing the *same* supersession path an input change would take:

```ts
// sketch — HMR routes an edit into the invalidation the graph already has
import.meta.hot?.accept((mod) => {
  for (const [name, compute] of Object.entries(mod.cells)) {
    registry.cell(name)?.redefine(compute);   // abort stale run, keep last value, recompute
  }
  log.notice("hmr", `redefined ${Object.keys(mod.cells).length} cells`);
});
```

The cell's existing `ctx.signal` does the cancellation; its last-committed value is what stays on
screen (dimmed) until the new compute settles; dependents hold via the graph's normal
`NotReadyError` propagation. Nothing HMR-specific is invented — the edit just enters through a new
door into machinery that already exists.

### A `durable()` registry for resources that must outlive the module

Live resources — a WebSocket, a Web Worker, a running computation — can't be serialized into a reload
handoff and can't be recreated for free. They should be owned by a **stable registry keyed by
identity**, not by a module instance, so a re-evaluated module *finds and adopts* the existing one:

```ts
// sketch — created once, adopted on every subsequent evaluation, disposed only on real teardown
const socket = durable("ws", () => new WebSocket(url));      // idempotent: adopt if present
const worker = durable("worker", () => new Worker(workerUrl));
```

This is the same move as the observability registry in
[`agent_observable_web_workers.md`](agent_observable_web_workers.md): a handle that *persists across
churn* while the instances that use it come and go. Generalize that `window.__<ns>` idea into a
`window.__durable` registry for all long-lived resources, and idempotent setup (desideratum 4) and
resource survival (desideratum 1) both fall out of it.

### Plain values ride the reload handoff; resources ride the registry

For serializable durable state, use the bundler's own handoff channel — `import.meta.hot.dispose`
stashes it, the new module reads it back:

```ts
import.meta.hot?.dispose((data) => { data.model = model; });   // stash on the way out
const model = import.meta.hot?.data.model ?? initialModel();   // adopt on the way in
```

That is enough for plain data. It is *not* enough for a socket or a worker — you can't serialize a
live connection — which is exactly why resources go through `durable()` instead. The rule of thumb:
**serializable state → `hot.data`; live resources → a keyed registry.**

### Split files along the durable/disposable line

Give HMR an easy job by keeping the two kinds of code in different modules: pure logic (freely,
frequently hot-swapped) apart from resource wiring (guarded, adopts existing, rarely changed). Then
the files the agent edits constantly are the *safe* ones, and the risky wiring is edited rarely and
deliberately. This also lines up with the "debug the source, not the built bundle" anti-pattern in
[`agentic_frontend_debugging.md`](agentic_frontend_debugging.md).

### Detect shape changes and fail loud

When an edit changes the shape of durable state, don't hot-swap onto the old shape. Version the
durable model (a plain integer bumped when its shape changes); on reload, compare; on mismatch, run a
migration if one exists, else force a full reload with a logged reason:

```ts
if (data.modelVersion !== MODEL_VERSION) {
  log.notice("hmr", `model shape changed ${data.modelVersion}→${MODEL_VERSION}; full reload`);
  import.meta.hot?.invalidate();   // clean reset beats silent corruption (desideratum 8)
}
```

### Make the reload observable

Route the HMR event through the same logger the rest of the app uses, naming what survived and what
reset (desideratum 9). This closes the loop with the observability docs: the agent reads
`window.__app.report()` and sees not just the current state but *what the last edit did to it*.

---

## Open questions

This is a desiderata document, and some of the hardest parts are genuinely unsettled. Flagging them
honestly:

- **Cancel-and-restart vs. let-it-finish for in-flight work.** When an edit touches a running
  30-second computation, is the right behavior to abort and restart with the new code, or to let the
  old run finish and apply the new code to the *next* run? Probably configurable per cell, but the
  default is not obvious and likely task-dependent.
- **Matching identity across structural edits.** Renaming a cell, splitting one into two, or
  reordering — how does HMR know the new `fooBar` *is* the old `foo`? Stable explicit keys help, but
  the agent doing the editing could also *emit* the mapping ("I renamed foo→fooBar") as part of the
  edit, which is a uniquely agentic affordance a human HMR setup never had.
- **How much should the agent know about HMR semantics?** The agent is the one editing. It could
  reason about whether its own edit is hot-safe and choose to preserve or reset deliberately — a
  capability worth designing *for*, not just around.
- **Testing HMR itself.** The mechanism deserves the same "simulate the trigger" treatment as the
  stall watchdog: drive a synthetic edit, assert the durable roots survived and the derived state
  recomputed. What that harness looks like is unexplored.

The throughline, though, is settled and worth holding onto: **structure the code so a code edit is
just another invalidation over durable roots the edit leaves untouched** — and let the reactive graph
you already have do the rest.
