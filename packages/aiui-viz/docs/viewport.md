# The resize seam: viewport, element size, and `now`

Status: shipped 2026-10-17 (`src/viewport.ts`, tests in `src/viewport.test.ts`). `PlotFigure` is the
first consumer; the other ResizeObservers in the repo migrate onto it later (the plan's deferred
list).

Observable gives a notebook four reactive values for free: `width` (the main column's width), `now`
(the time, ticking per animation frame while a cell reads it), `dark` (the color scheme), and an
element's width through a resize generator. aiui had `dark` — `colorMode()` in
`src/site/color-mode.ts` — and nothing for size or time. This note states what the three new values
measure and why, how they survive a hot reload, and why none of them is in a registry.

## What each value measures

**`viewportWidth()` / `viewportHeight()` — the layout viewport.** `documentElement.clientWidth` and
`clientHeight`: the window minus a classic scrollbar, the number a `@media (min-width: …)` query
compares against. Observable's `width` is the width of the notebook's one column. An aiui page has
no such column — it is a lab panel beside a sidebar, two figures in a grid, a deck, a gallery shell
around a page — so there is no page-level box a component could lay out against, and the one that
exists is the viewport. The viewport pair is for page-level decisions (a layout breakpoint, a
phone-vs-desktop branch in code the CSS cannot reach); a component wanting its own size asks the
next pair. Updated on the window's `resize` event and, because a scrollbar appearing or leaving
changes `clientWidth` with no `resize` event, on the html element's own resize observation.
Always on: one listener per document, nothing to gate.

**`elementWidth(el)` / `elementHeight(el)` — an element's content box.** The content box is what
the ResizeObserver reports (`contentRect`) and what a child lays out inside, so a figure rendered
at `elementWidth(host)` fits its host exactly, padding included. `el` is an element or an accessor
for one (`() => host`, for a ref that binds later); an element that is not there, not connected, or
`display: none` reads `0`, and a consumer treats `0` as "unmeasured", never as a size. The first
value is a synchronous measurement (bounding box minus padding and border), so a reader has a real
number before the observer's first report. **One shared ResizeObserver** serves every element on
the page; one element has one observation however many readers it has — two components reading
the same host, or one component reading width and height, share one entry. The observation starts
with the first reader and is released after the last one goes.

**`now()` — `Date.now()` per animation frame, while read.** A memo over `now()` re-runs once per
frame; a page with no reader runs no frame loop. The loop starts on the first read from a linking
computation and stops when the last one is disposed. `Date.now()` rather than the frame timestamp,
so the value compares with the timestamps in a page's data.

## Subscriber gating

Solid 2.0 signals take an `unobserved` option: a hook that fires when the signal's last subscriber
unlinks. That hook is the reference count — Solid already keeps one. Three facts make it the right
seam, each pinned by a test:

- A recompute that reads the signal again **keeps its link** (Solid reuses the dependency edge in
  place), so the hook stays quiet across the per-frame re-runs of a `now()` reader. A dispose, or
  a branch that stops reading, fires it.
- `getObserver()` is the owner during a tracked read inside a memo, an effect's compute or a JSX
  expression; probe reads (`latest()`, `isPending`) report a placeholder observer and link nothing;
  untracked reads report none. Only a **linking** read starts a resource. An untracked
  `elementWidth(el)()` is a one-off measurement; an untracked `now()` is the last frame's value.
- The stop runs **one microtask after** the hook, cancelled by any read in between, so a compute
  whose dependency order changed (unlink, then relink in the same pass) does not cancel and
  re-request a frame.

The alternative — registering `onCleanup` from inside the read — was rejected: `onCleanup` throws
in `createTrackedEffect` and `onSettled` scopes (`CLEANUP_IN_FORBIDDEN_SCOPE`), so a read in the
wrong kind of computation would fail where a plain signal read would not.

## Hot reload, and why nothing is registered

**Durable, not a plain module signal.** The owner left the choice open: follow `colorMode`'s durable
pattern, or a module-level Solid signal if the durable path adds nothing. It adds the one thing that
matters here. Every one of these values holds a document-level resource — a `resize` listener, a
ResizeObserver, a `requestAnimationFrame` loop — and a module-level signal is re-created on every
evaluation of the module: the first hot edit to anything that imports `aiui-viz` would attach a
second listener feeding an orphaned signal, a second observer, and (while a reader was live across
the swap) a second frame loop, with the old readers counting against the old loop and the new ones
against the new. The durable registry hands the re-evaluated module the same boxes
(`aiui:viewport`, `aiui:resize-observer`, `aiui:now`), so the listener count stays at one and the
reference count stays whole across the swap. A plain signal would have been right only for a value
with nothing behind it. The one cost is the non-browser guard before the durable call (the registry
lives on `window`), which `colorMode` already pays.

**Not in any enumerated registry.** The durable registry is keyed and never enumerated — nothing
walks it, which is why framework values may live there. The registries that *are* enumerated are
the control surface, the cell registry and the bridge registry, read by the `report` tool: a
control is a curated knob an agent may set, a cell is the app's dataflow. The viewport's width is
neither; registering it would hand the agent a `set` target it cannot drive and a cell that is not
the app's. These are plain `createSignal`s, so the `report` tool, the dependency edges and the
source processor's stamps never see them.

## Consumers

`PlotFigure` (`src/plot.tsx`): the figure's `width` is `elementWidth(host)` unless the author's
options set `width`; a `0` measurement leaves Plot's default. The host element is created in the
component body rather than by a JSX ref, because an effect's **compute runs before refs bind** (the
handler runs after) and the width must be read in the compute to be tracked. Consumers that set
`width` themselves (seismos' Gutenberg–Richter view) are unchanged.

To migrate another observer: replace the component's `new ResizeObserver(...)` with a read of
`elementWidth(host)` (or both dimensions) in the compute that needs it; drop the `observe` /
`disconnect` pair, the cleanup comes from the read. The remaining sites are listed in the plan.
