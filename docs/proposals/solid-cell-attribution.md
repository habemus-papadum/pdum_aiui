# Runtime element → cell attribution from Solid 2 internals

Status: **spike, shipped behind an explicit opt-in** (July 2026). Companion to the frontend-for-agents
attribution contract (`data-cell` / `data-cell-loc`) and to `packages/aiui-viz/src/cell-attribution.ts`,
which is the mechanism this proposal describes. Pinned to `@solidjs/signals@2.0.0-beta.15`.

## The question

The dev-overlay's attribution contract is two DOM attributes on the element that renders a cell's
value: `data-cell` (the cell's name) and `data-cell-loc` (its `cell(...)` definition site). Today
only `CellView` writes them, by explicit authorship. Can an app that reads a cell straight into JSX
get the same stamps **automatically**, derived at runtime from Solid's reactive graph — no `CellView`,
no build-time babel pass?

The bar set for this spike was **exact or nothing**: no heuristic that can misattribute under
batching or concurrency. Reaching into Solid's private computation internals is acceptable (with the
version pinned and a loud failure if the shape shifts); guessing is not.

## Why the obvious approaches fail

Every finding below is from runtime experiments — jsdom plus the real `vite-plugin-solid` transform,
i.e. the exact compiled output the workbench runs — not from reading dist.

**The render effect holds no reference to the DOM node it writes.** Inside a cell read that happens
during rendering, `getObserver()` returns the render effect and `getObserver() === getOwner()`.
Enumerating every field of that object and scanning for anything with a `nodeType` returns nothing:
the target node is captured in the effect's `_fn`/`_effectFn` **closures** (`insert(parent, …)` closes
over `parent`), and closures are not reflectable. So "walk the owner graph to a DOM link" is dead.

**@solidjs/web's write helpers can't be intercepted through public exports.** Reactive text and
attributes bottom out in `insertExpression` / `setAttribute`, but babel binds those as ES-module
imports inside the compiled component, and ESM live bindings can't be monkey-patched. The only
interception surface is the **DOM prototypes** (`Element.setAttribute`, `Node.textContent`,
`CharacterData.data`, `insertBefore`/`appendChild`/`replaceChild`), which @solidjs/web ultimately
calls.

**No owner or observer is set at write time.** At the DOM write, `getObserver()` is `null` (commit runs
untracked); on a reactive **update** `getOwner()` is `null` too. And updates are **two-phase** — every
effect's compute (reads) runs, then every effect's commit (writes) runs — so a write cannot be paired
to its effect by any ambient identity, only by order, and order-pairing is defeated the moment an
element writes without reading a cell (a scrub pill) or an effect reads N cells and writes one node.
An earlier heuristic built on same-tick FIFO ordering was implemented and measured; it silently
misattributed exactly here, which is why it was discarded under the exact-or-nothing bar.

## The mechanism that is exact

Two private-internals facts, both verified at runtime, open an exact path:

1. **`getObserver()` at a cell read *is* the render effect** performing it — a computation object with
   writable `_fn` (compute) and `_effectFn` (commit) fields.
2. **`dev.js:runEffect` invokes `node._effectFn(...)` freshly at commit** (it reads the field, it did
   not capture a reference). So replacing `_effectFn` on a specific effect makes Solid call our wrapper
   at that effect's commit.

So: at each cell read (via `attributedRead`, or a wrapped `.latest`), record `{name, loc}` under the
observing effect (ordered), and — once per effect — wrap its `_fn` (reset the read list at each
recompute, keeping conditional reads correct) and its `_effectFn` (publish a module-global
`committing = <that effect>` for the duration of its commit; this wrapper is what supplies the
committing identity Solid otherwise leaves `null`). Every DOM write to a still-**detached** element is
buffered against `committing`. When the commit finishes we hold the effect's ordered cell-reads `R` and
its ordered writes `W`, and **pair them by position**.

Position pairing is exact because of how `babel-preset-solid` compiles a component. A component's
dynamic **attributes** become **one** effect whose compute reads them in source order and whose commit
writes them in the *same* order:

```js
_$effect(() => ({ e: p(), t: q(), a: a(), o: b() }), ({ e, t, a, o }, _p$) => {
  e !== _p$?.e && _$setAttribute(_el$3, "d", e);      // read #0 → write #0
  t !== _p$?.t && _$setAttribute(_el$4, "d", t);      // read #1 → write #1
  a !== _p$?.a && _$setAttribute(_el$7, "width", a);  // read #2 → write #2
  o !== _p$?.o && _$setAttribute(_el$8, "width", o);  // read #3 → write #3
});
```

`W[i] ↔ R[i]`, and each write carries its element. Reactive **inserts** (children/text) are each their
own effect reading one cell — trivially exact. Two different cells across two attributes are split
correctly (a case the discarded heuristic could never do). Stamping is restricted to the **detached**
construction commit (`el.isConnected === false`) and frozen thereafter, because updates commit
*guarded partial* writes (`e !== _p$?.e`) that would break positional alignment — and the element → cell
mapping never moves, so once is enough.

**When it can't be exact, it fails loudly, never wrong.** If `|W| ≠ |R|` for an effect's construction
commit, the effect held a write with no cell read to pair — the signature of a non-cell dynamic
attribute we cannot observe (Solid exposes no hook for plain-signal reads), or several cells
interpolated into one node. The module logs a `console.error` and refuses to stamp those elements. It
is also pinned: `enableCellAttribution()` runs a synthetic probe (a throwaway render effect) confirming
`getObserver()` exposes writable `_fn`/`_effectFn`, and throws if a future beta has moved the internals
— surfacing the breakage instead of silently attributing nothing.

## What is and isn't attributable

- **Exact, unconditionally — reactive children/text.** `{cell()}` in an element body is its own insert
  effect reading one cell. This covers text readouts (the workbench's probability value and moment
  tiles).
- **Exact only when a component's every dynamic *attribute* is a cell read.** Solid batches all of a
  component's attributes into one source-ordered effect, so a **single** non-cell dynamic attribute
  anywhere in the component (a computed geometry, a derived class) breaks positional alignment for
  **all** of its attributes. This is detected and loud-failed, never misattributed. In practice it means
  fixed chrome must be static (or the value-bearing attributes isolated into their own component). In
  the workbench scenery the plot's axis lines, label positions and `viewBox` are fixed geometry, so they
  are written as static literals; that leaves the four path `d`s (each a `curves` read) as the component's
  only dynamic attributes, and they attribute exactly.
- **Not attributable — a cell still pending at construction.** An async cell that is `undefined` when the
  tree is built emits no write to pair; it is loud-failed if it shares an attribute effect, or simply left
  unstamped as an insert (its value first reaches the DOM on a two-phase, already-mounted update). The
  workbench cells are synchronous, so this doesn't arise there.

## The upstream ask

General **attribute** attribution — a component freely mixing cell and non-cell dynamic attributes — is
not achievable at runtime with today's dom-expressions output, because the batching hides which of a
combined effect's writes came from a cell and non-cell reads are unobservable. Any one of these upstream
changes would make it exact and general, by letting a write handler read the committing effect's recorded
reads directly instead of inferring by position:

1. **A "currently-committing effect" accessor** — `getObserver()` (or a sibling) valid during the
   `effectFn`/commit phase, where it is `null` today.
2. **The owner kept live through the commit** — `getOwner()` returning the render effect during
   `effectFn`, so writes map to effects by identity, phase-proof.
3. **A dom-expressions commit callback** carrying the `(element, sourceExpression)` pair it already has
   in hand inside `insert`/`setAttribute` — the most direct fix, and it would also give per-element
   granularity instead of per-component-template.

## What shipped

- `packages/aiui-viz/src/cell-attribution.ts` — `enableCellAttribution()` (idempotent, reversible,
  version-pinned, probe-guarded) and `attributedRead(cell)`; exported from `index.ts`.
- `packages/aiui-viz/src/cell-attribution.test.tsx` — exact inserts; exact all-cell attributes including
  two distinct cells split by position; loud-fail (asserted `console.error`) on a non-cell-mixed
  attribute effect; non-cell writers untouched; stable across updates; idempotent + reversible.
- `packages/aiui-dev-overlay/workbench/src/scenery.tsx` — the plot paths, probability readout and moment
  tiles read their cells through `attributedRead` (no `<Show>`, no `CellView`); `enableCellAttribution()`
  is armed in `mountScenery`; the plot's fixed axis/`viewBox` geometry is static so the paths' attribute
  effect is cell-only. Verified against the real mounted scenery: all four paths → `curves`, readout →
  `probability`, both tiles → `moments`, axis/pills/labels unstamped, no loud-fail.

`@habemus-papadum/aiui-viz` (74) and `@habemus-papadum/aiui-dev-overlay` (524) suites green; `tsc --noEmit`
clean for aiui-viz and the workbench; biome clean.
