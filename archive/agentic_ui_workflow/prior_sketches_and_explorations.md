# Prior sketches and explorations

Things we have built or prototyped before that feel relevant to an agentic UI workflow, captured
here so they aren't forgotten. These are **sketches, not settled pieces** — we're recording roughly
what each one is and how it works, not committing to how (or whether) it fits the larger picture yet.
Each is described in the generic; the specifics of where they came from don't matter.

## 1. Source-location tagging for components (a JSX locator)

**What it is.** A build-time transform (a Babel plugin, run inside the framework's compile step) that
rewrites JSX so every rendered element carries a data attribute encoding *where in the source it came
from* — the file plus line/column of the originating tag. After it runs, a `<button>` in the live
DOM knows it was authored at, say, `App.tsx:10`, and that fact rides along on the element itself.

**Why it's interesting for an agent.** It closes the gap between "the thing the user is pointing at
on screen" and "the code that produced it." In a pairing loop where a human says "this component is
wrong," the source location is exactly the handle an agent needs to jump straight to the right lines
— no guessing from rendered text. It's the DOM-side analogue of the tagged, greppable logging in
[`agentic_frontend_debugging.md`](agentic_frontend_debugging.md): make the origin *legible* rather
than reconstructed.

**State: wired but inert.** In the prototype the transform emitted the attributes, but nothing
*read* them — there was no in-page consumer and no editor bridge hooked up. The data was present on
every element; the half that turns it into an action (hover/click an element → resolve its origin →
hand it to a human or agent) was never built. So we know the tagging works; we have not exercised it.

## 2. A dev-only overlay injected into the page (a floating tool surface)

**What it is.** A small script that, in development only, injects a floating button into any page,
isolated inside a **Shadow DOM** container so its styles can't collide with — or be affected by — the
host page. It guards against double-injection and is gated to dev builds. The intent was a persistent,
app-agnostic *surface* for developer/agent tooling that rides on top of whatever app is running.

**State: a shell.** The button mounts and is styled; clicking it currently just logs a placeholder.
The actual behavior behind it — element picking, inspection, capturing feedback — was left as a TODO.
It is scaffolding for a tool surface, not a tool yet.

Two things worth noting about the shape, because they're the reusable part:

- It was a **plain module you import and call**, not a build-tool plugin — injection was manual per
  entry point. An open direction is to make it inject itself automatically (e.g. via a dev-server
  transform) so *any* page gets the overlay for free, closer to "a dev tool you can overlay on any
  website."
- The **Shadow DOM isolation** is the right instinct and echoes the same discipline as the
  `window.__<ns>` observability handle in
  [`agent_observable_web_workers.md`](agent_observable_web_workers.md): a durable, side-loaded
  surface that coexists with the app without entangling it.

## The obvious union we haven't built

These two are complementary halves that were never connected: (1) produces the *data* (where did this
element come from), and (2) is the *surface* (a floating UI to act on it). The natural combination —
click the overlay's button, pick an element on screen, read its source-location attribute, and hand
"this is `App.tsx:10`" to a human or an agent — **does not exist yet**. Both remain sketches.

## Open questions about fit

- Where does the "point at a component → get its source location" capability belong relative to the
  cell / reactive model — is the useful unit a DOM element, or the cell that produced it?
- Should the overlay be the delivery vehicle for the observability handles (logs, state snapshots,
  `report()`) described in the other docs, rather than a separate surface?
- Is auto-injection (any page gets the overlay + locator for free) worth the machinery, or is
  per-app opt-in enough for the workflows we actually run?

Recorded as prior art to draw on, not as a plan.
