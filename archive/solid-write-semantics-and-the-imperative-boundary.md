# Solid 2.0 write semantics and the imperative boundary

## Context

The same bug has been found live, by the user, at least **seven times**: code writes a signal, reads
it back in the same synchronous flow, and gets the *pre-write* value — so a state machine takes the
wrong branch, a cap lights inverted, a disarm stomps back to armed.
`packages/aiui-extension/docs/STATUS.md` (§F1) records the census: the phase machine, the ink flag,
selection presence, the key blip, the zoom restore, the channel-reconnect check, and the video/fps
caps. The fix was distilled into a library primitive — `aiui-viz`'s **`liveSignal`**
(`packages/aiui-viz/src/live-signal.ts`) — after the fifth bite. **The seventh bite happened after
the primitive existed.**

This document is the result of taking that recurrence seriously enough to read Solid's source and
measure its behavior rather than re-derive the folklore an eighth time. The conclusion is
uncomfortable:

> **The recorded diagnosis is right about the symptom and wrong about both the cause and the cure.**
> Reads are stale **always**, not "sometimes." Solid **ships** the fix (`flush()`), and we never
> found it because we grepped for the wrong name. And **`liveSignal` cannot fix the bugs it was
> built for** — it makes a *direct* read fresh, but every *derived* read stays stale, and the cap
> bugs are derived reads.

Everything below marked **measured** was established against `solid-js@2.0.0-beta.15` with a probe
suite (§8). Everything else is labeled as reasoning.

---

## 1 · What Solid 2.0 actually does (measured)

### The mechanism

`setSignal` does not write the value. It **stages** it:

```js
// @solidjs/signals/dist/dev.js:2200-2201
if (el._pendingValue === NOT_PENDING) queuePendingNode(el);
el._pendingValue = v;          // staged. `el._value` is untouched.
…
schedule();                     // dev.js:340-344 → queueMicrotask(flush)
```

The committed value `_value` is only overwritten when the queue drains (`dev.js:312`). And `read()`
returns the committed value to anyone standing outside the reactive graph:

```js
// @solidjs/signals/dist/dev.js:2006  — the whole bug, on one line
return !c || el._pendingValue === NOT_PENDING ? el._value : el._pendingValue;
//     ^^^^ no reactive context  →  return the OLD, committed value
```

`c` is the current reactive context. If there isn't one, the pending write is *ignored*.

### The table

| You write, then read, from… | Write | Same-tick read |
| --- | --- | --- |
| A plain function, DOM event handler, `chrome.*` callback, timer, socket | allowed | ❌ **stale** |
| A component body, memo compute, `createRoot` body | ❌ **throws** `REACTIVE_WRITE_IN_OWNED_SCOPE` | — |
| An effect **handler** (2nd arg of `createEffect`) | allowed | ❌ stale, + `STRICT_READ_UNTRACKED` warning |
| After `flush()`, or inside `flush(fn)` | allowed | ✅ **fresh** |
| After one `await` (a microtask is enough) | allowed | ✅ fresh |

Read the first two rows together: **there is no legal place where write-then-read-back works.**
Outside a reactive scope it defers; inside one it throws. This is not a quirk with two exceptions
(which is how our docs frame it) — **it is the design.** Solid 2.0's contract is:

> **The reactive graph is the only reader of your writes.**

### The silent breaking change — and why *agents* keep writing this bug

**Measured on `solid-js@1.9.14`:** `setX('armed'); x()` returns `'armed'`. Even inside `batch()`.
Solid 1.x had read-your-own-writes. **Solid 2.0 removed it behind an identical API.** Same
`const [x, setX] = createSignal(0)`; opposite meaning. No rename, no deprecation, no type-level
marker, no migration warning.

This is the root cause of the root causes, and it is *specifically* lethal to this project:
**this codebase is largely LLM-authored, and every model's training corpus is overwhelmingly
Solid 1.x.** An agent asked to write a state machine will emit `setPhase(p); if (phase() === p)` **by
default, from prior**, on every new file. That is why the bug regenerates instead of staying fixed,
and why bite #7 landed *after* the primitive existed.

The operational consequence, which shapes every recommendation in §6:

> **Documentation cannot fix a wrong prior that re-instantiates itself on every new file.
> Only something that fails loudly can.**

### Three escape hatches Solid ships that we never used

1. **`flush()` / `flush(fn)`** — exported from `solid-js`, in **both** the dev and prod builds.
   Solid's own docblock (`@solidjs/signals/dist/types/core/scheduler.d.ts:88-95`) describes our exact
   situation: *"Reactive updates are normally batched onto the microtask queue… Call `flush()` when
   you need to **observe** the result of those writes synchronously — most commonly in tests, but
   also **at the boundary of imperative integration code**."*
   We grepped for **`flushSync`** — the React / Solid-1.x name — got zero hits, and concluded no
   escape hatch existed. The word `flush` (as a Solid API) appears **nowhere** in our source, docs,
   skill, template, or demos.
2. **`createSignal(v, { ownedWrite: true })`** — a public `SignalOptions` field that permits writes
   inside owned scopes. We *know* this one: it is documented at `docs/guide/frontend-hard-won.md:17`
   and used at `packages/aiui-viz/src/hot-graph.ts:111`. It never reached the panel, whose entire
   architecture was bent around the throw it disables (§5b). Note also that
   `REACTIVE_WRITE_IN_OWNED_SCOPE` is a **dev-only assertion** — zero occurrences in `prod.js`.
3. **The setter returns what you wrote.** `const next = setPhase("armed")` hands you the new value
   for free. `docs/guide/frontend-hard-won.md:26` even says *"return the value you computed instead"*
   and `packages/aiui-viz/src/standard-tools.ts:151` does exactly this — but the insight was never
   generalized from tools to machines.

---

## 2 · The imperative boundary — what the phrase means

This phrase does a lot of work in this document, so here it is precisely.

### The transaction model

Our own user guide already reaches for the right word: *"Writes are batched into **transactions**"*
(`docs/guide/frontend-user-guide.md:554`). Take it literally, because it is literally true:

- **`set(v)` is an UPDATE inside an open transaction.** It stages a change; it does not alter the
  visible row.
- **The COMMIT happens at the next microtask** (`schedule()` → `queueMicrotask(flush)`).
- **The reactive graph is the code that runs *inside* the transaction.** Memos, effect compute
  functions, JSX expressions, cell `deps` — Solid calls them, they see staged values in a consistent
  snapshot, and Solid re-runs them whenever a staged value would change their answer.
- **Everything else runs *outside* the transaction** and sees the last **committed** state.

`flush()` is `COMMIT`.

### The definition, and the one-question test

> **An imperative boundary is any code that Solid did not call.**

That is the entire definition, and it is mechanically checkable:

> **Ask: who called this function?**
>
> - **Solid called it** → you are **inside the graph**. (A memo's compute; an effect's *compute*
>   function — the first argument; a JSX expression; a cell's `deps` thunk.) Reads here are tracked
>   and see staged values. Writes here **throw**.
> - **Anything else called it** → you are **at an imperative boundary**. The browser fired an event.
>   Chrome delivered a message. A timer fired. A socket delivered a frame. The MCP dispatcher invoked
>   a tool. Writes here are allowed but **staged**; reads here return the **last committed value —
>   not what you just wrote.**
>
> Runtime check, if you're ever unsure: `getObserver()` (exported from `solid-js`) is non-`null`
> inside the graph and `null` at a boundary.

The single most common misreading — and the one that caused the panel's architecture — is thinking
"I'm in a Solid component, so I'm inside Solid." **You are not.** A component *body* runs inside the
graph (writes throw there). But the `onClick` handler that body creates is called by the **DOM**, not
by Solid. It is boundary code. The JSX around it is irrelevant.

### The two directions, and why they need different cures

**Inbound (world → graph).** Something outside calls you; your code writes signals. This is where
writes originate — and **every one of the seven bites happened here.**

| Inbound boundary in this repo | Where |
| --- | --- |
| Keyboard dispatch (`applyLeaderKey` → `leaderDispatch`) | `packages/aiui-extension/src/panel/main.tsx` |
| `chrome.runtime.onMessage` relay handlers | `main.tsx:~490-560` |
| The engine's `onEvent` callback | `main.tsx` |
| A `requestAnimationFrame` tick | `demos/gallery/src/pages/aztec/store.ts:144` |
| An agent tool's `run()` (called by the MCP dispatcher) | `packages/aiui-viz/src/standard-tools.ts:141` |
| A `queueMicrotask` callback | `main.tsx:834` |
| A keyboard `dispatch(command)` | `demos/walkthrough/src/model/keys.ts:36` |
| Any `<button onClick={…}>` handler | everywhere |

*Cure:* don't read back at all (use the local you computed, or the setter's return value); and where
the flow genuinely must observe its own writes, `flush()` — which **commits**, rather than peeking.

**Outbound (graph → world).** Reactive state must be pushed into something that is not reactive: an
imperative DOM class, a canvas, a worker, a port, a plotting library.

| Outbound boundary in this repo | Where | Form |
| --- | --- | --- |
| `syncIslands()` | `main.tsx:703` | ❌ hand-called (15 sites) |
| `broadcastRing()` | `main.tsx:494` | ❌ hand-called (6 sites) |
| `syncInkPointer()` | `main.tsx:366` | ❌ hand-called (6 sites) |
| `syncTabStream()` | `main.tsx:337` | ❌ hand-called (4 sites) |
| `syncVideo()` | `main.tsx:763` | ❌ hand-called (3 sites) |
| Observable Plot bridge | `packages/aiui-viz/src/plot.tsx:14-21` | ✅ `createEffect(source, handler)` |
| Mosaic/vgplot bridge | `packages/aiui-viz/src/mosaic.tsx:50-65` | ✅ `createEffect(source, handler)` |
| `inkFade` relay | `main.tsx:1310` | ✅ `createEffect(source, handler)` |

*Cure:* `createEffect(() => derivedValue(), value => pushIt(value))`. The graph pushes; nothing is
hand-called; nothing can be forgotten. Note that the correct form already exists in the codebase
three times — including once in `main.tsx` itself, 240 lines below a broken hand-push.

### Why the two cures are secretly one

**Measured:** `flush(fn)` commits the writes, recomputes the memos, **and runs the effect handlers
synchronously.** So if the outbound side is effects and the inbound side is `flush()`-wrapped, then
by the time a dispatch returns, the state is committed *and* the islands have already repainted:

```ts
const dispatch = (event) => flush(() => { /* writes only */ });
// after this line: direct reads, derived memos, AND the imperative islands are all current.
```

STATUS.md's **F1** (stale same-flow reads) and **F2** (forgotten `sync*` calls) are not two problems.
They are one problem seen from its two sides, and one mechanism closes both.

### The subtlety that kills `liveSignal`

**A boundary read of a *derived* value is stale too.** This is the fact that decides the whole
design, and nothing in our docs says it. Making the *raw* value fresh is not sufficient, because the
things boundary code actually reads — the caps, the labels, the claims — are **memos over** the raw
value. The boundary must **commit**, not **peek**. `liveSignal` peeks.

---

## 3 · Why it keeps happening (root causes, ranked)

**R1 · Solid 2.0 silently removed read-your-own-writes, and every LLM prior encodes the old
semantics.** (§1.) The bug is *regenerated*, not merely un-fixed. This dominates all other causes and
is the reason the mitigation must be mechanical rather than documentary.

**R2 · Our own guidance under-scopes the rule.** Both the canonical doc and the agent-facing skill
state the fact correctly and then **scope it away**:

> *"Two places this bites: an agent tool that `set`s then returns a `get` … and driving the app via
> `evaluate_script`."* — `docs/guide/frontend-hard-won.md:26-28`
>
> *"Where it bites: a tool that sets then re-reads … and tests."* — `docs/guide/frontend-user-guide.md:556`
>
> *"Writes are batched: `set` then `get` in the same tick reads stale. Tools return the value they
> computed…"* — `frontend-design/skills/frontend-design/SKILL.md:161`

An agent writing a keyboard dispatcher reads that list, correctly concludes *"I am not a tool and not
a test,"* and writes the bug. The list is not wrong; it is the *two places it had bitten us so far*,
frozen into a definition. Neither passage mentions `flush()`. Neither mentions that derived values
are stale too. Neither mentions that the staleness is confined to reads **outside a reactive scope** —
the one fact that would make the whole model comprehensible and would explain *why the demos are
safe*.

**R3 · The library's recommended primitive has the trap, and doesn't look like it.**
`control()` → `durableSignal()` → bare `createSignal` (`control.ts:221`, `durable.ts:69`). Every
`control().get()` in a dispatch path is a landmine wearing the costume of a first-class primitive.
This is *precisely* how bite #7 happened after `liveSignal` existed: the new feature read bare
`control()`s in a dispatch path. `createStore` has the same deferred semantics (**measured**).

**R4 · There was no reference implementation of a correct imperative boundary to copy.** The demos
never have one — they are pure dataflow. The panel is the *first* place in the repo that needed an
imperative machine, and it had nothing to imitate. So it invented `liveSignal`. (See §5a: this
inverts the usual worry — our example code is *good*; we simply have **no example of the hard
case**.)

**R5 · The mitigation added a state kind instead of removing the hazard.** We now choose per-site
among **five** state kinds — `createSignal`, `control`, `durableSignal`, `liveSignal`, `createStore` —
and the *default* is the unsafe one. STATUS.md diagnoses this exactly (*"nothing structural forces
machine-read state through the safe primitive"*) and then proposes a sixth (§6, anti-mitigation A).

---

## 4 · Is `liveSignal` sound, or a code smell?

**Verdict: a code smell — a correct implementation of the wrong idea.** The idea it implements is
*"restore Solid 1.x semantics."* The idea it should have implemented is *"stop reading back."*

### How it works

`packages/aiui-viz/src/live-signal.ts:46-65`. It keeps a plain JS field `now` as the real source of
truth, plus a version-counter signal used **only** for notification. `set()` writes the field and
bumps the counter; `get()` subscribes to the counter (so JSX and effects still re-run) but **returns
the field** — which is never stale, because it was never staged. One accessor, two worlds.

It is the classic external-store-plus-subscribe shape (React's `useSyncExternalStore`). Within its
own terms it is well-built: the version counter sidesteps signal equality and function-value storage,
and the tests pin the behavior.

### Why it fails anyway

**1 · It only fixes one hop — and the bugs it was built for are two hops.** *(Measured.)* A
`createMemo` over a `liveSignal` is **still stale** in the same tick. Two hops: still stale.
Reproducing the panel's actual shape:

```
phase.get()  → "armed"     ← liveSignal delivers, as promised
capLabel()   → "off"       ← the memo over it is STALE. syncIslands() paints "off".
```

The ✏️/📋/video cap bugs *are* memo-derived reads. **`liveSignal` cannot fix them** — which is why the
cap fixes in `a9b29e6` needed hand-inlined re-reads *plus* extra `syncIslands()` calls anyway. The
primitive creates a false sense of safety: the state it "protects" feeds derived values it does not.

**2 · In practice it became a double-write with a strictly worse failure mode.** Bite #7's fix
(`10c1522`) added a `liveSignal` **beside** the existing `control()`, written by hand at every call
site:

```ts
// main.tsx:711-712  — two sources of truth for one piece of state
const videoOnLive   = liveSignal(videoOn.get());
const videoModeLive = liveSignal(videoMode.get());
// main.tsx:1066-1067 — kept in sync only by the panel's own keyboard path
const next = !videoOnLive.get();
videoOnLive.set(next);
videoOn.set(next);
```

But `videoOn` is an **agent-visible control** (`panel/model/store.ts:69`), and
`aiui-viz/src/standard-tools.ts:151` lets *any agent* call `set("videoOn", true)` — which moves the
control and **never the mirror**. Nothing reconciles them (there are only two `createEffect`s in the
whole package — `main.tsx:208` and `:1310` — and neither watches it). The video claim reads the
*mirror* (`main.tsx:764`).

> **So an agent turning on video moves the control, the durable state, and the UI — and sampling
> never starts. Permanently.**

The mitigation converted a **one-tick staleness** into an **unbounded desync**, in the
agent-reflection layer that is this project's headline feature. This is the strongest single argument
against the primitive: it doesn't just fail to fix the problem, it manufactures a worse one.

**3 · Its central claim is already false.** The docblock says *"The hand-rolled fix was always the
same pair … This is that pair, **once**."* It is not once: `hot-graph.ts:79-83` is an independent
second copy of the identical field+version pair, and the control-mirrors above are a third.

**4 · It opts the most important state out of the model the project bet on.** `cell.ts`'s own
docblock celebrates that Solid 2.0 *"made async first-class … commits are transactional, stale values
are served while new work is pending."* `liveSignal`'s value is a mutable global read at compute time,
outside `_pendingValue` / `_snapshotValue` / transitions / optimistic lanes. *(Reasoned, not
measured:)* if we ever adopt transitions, `createOptimistic`, or async boundaries over machine state,
`liveSignal` state will not participate and will tear the snapshot the rest of the graph is being
careful to preserve.

**5 · Its test pins a non-feature.** *(Measured.)* `live-signal.test.ts:25-30` asserts that two
`set(n => n+1)` in one tick yield 2 — presented as a distinguishing property. **A bare Solid signal
already does this** (`setSignal` resolves the updater against `_pendingValue`). The test passes for
`createSignal` too, so it distinguishes nothing.

### The narrow legitimate residue

The field+version pattern is *fine* for genuinely **external** mutable state that Solid does not
own — a WebGL context's current mode, a value mutated at 60 Hz outside the graph. That is arguably
what `hot-graph.ts` is doing. For **machine state that Solid should own**, it is wrong.

---

## 5 · Codebase audit: who needs help

| Area | Verdict |
| --- | --- |
| `aiui-viz` cells / controls / `CellView` | 🟢 Exemplary — but see the two library defects below |
| All demos, `aiui-test-app`, `aiui-oscillator`, `create-aiui` template | 🟢 Clean. Zero bugs of this class, ever |
| `aiui-viz` `control.set(updater)` | 🔴 **Live bug** — loses same-tick chained updates |
| `aiui-viz` `control` / `durableSignal` semantics | 🟠 The wrong default, wearing a first-class costume |
| `aiui-extension` `panel/main.tsx` | 🔴 The entire bug population lives here |
| `aiui-extension` video caps ↔ agent `set` | 🔴 **Live bug** — permanent desync (§4.2) |
| `demos/gallery` aztec player loop | 🔴 **Live bug** — playhead under-advances |
| `aiui-dev-overlay` | 🟠 Mostly vanilla DOM; same shape at smaller scale |
| `docs/guide/*` + the `frontend-design` skill | 🟠 Correct but under-scoped; omits `flush()` |

### 5a · The good — and the surprise about example code

A natural hypothesis is *"there is so much bad example code that people and agents copy it."*
**The opposite is true, and that is the interesting finding.**

Every demo (`gallery`, `walkthrough`, `twins`, `july09`), `aiui-test-app`, `aiui-oscillator`, and the
`create-aiui` starter are **cleanly declarative**: they write roots and never read back, letting the
graph re-derive. They have produced **zero** bugs of this class. Better, three example sites teach the
*counter*-pattern explicitly — `create-aiui/templates/app/src/model/scenery.ts:46-53` (*"Return what
was written, never a re-read: writes are batched"*), `demos/gallery/src/pages/aztec/graph.ts:235-239`
(the `seek` tool), and the template's test asserting on the setter's **return**.

Specific idioms worth pattern-matching on:

- **`packages/aiui-viz/src/dropdown.tsx:44-50`** — the antidote in miniature, requiring no primitive
  at all:
  ```ts
  const toggle = (): void => {
    const next = !open();          // compute FIRST
    setOpen(next);
    if (next) props.onOpen?.();    // branch on the LOCAL, never a re-read
  };
  ```
- **`packages/aiui-viz/src/plot.tsx:14-21`**, **`mosaic.tsx:50-65`** — the correct outbound boundary:
  a two-arg `createEffect` holding an imperative library at arm's length behind one seam.
- **`packages/aiui-viz/src/standard-tools.ts:151`** — `const written = c.set(...)`; returns the
  written value instead of re-reading.
- **`packages/aiui-viz/src/cell.ts`** — genuinely excellent async-first work whose docblock shows the
  author understood the transactional model exactly.

**The gap is not bad examples. It is the total absence of a good example of the hard case.** Nothing
in the repo demonstrates a correct imperative boundary, because until the panel, nothing needed one.

### 5b · The bad — `packages/aiui-extension/src/panel/main.tsx` (1,480 lines)

Essentially the entire bug population. An imperative state machine hand-stitched to a reactive store:
five hand-called `sync*` functions across ~34 call sites, and exactly **two** `createEffect`s in the
whole package.

The causal chain is documented in the code itself, and **it starts from a misreading**
(`packages/aiui-extension/src/panel/preview-pane.tsx:8-12`):

> *"IMPERATIVE ISLAND, deliberately (Solid 2.0 rule, learned live 2026-07-12): the shared surfaces own
> internal signals, so building or updating them inside a `createEffect` throws
> `[REACTIVE_WRITE_IN_OWNED_SCOPE]`. They are built once, outside the reactive graph, and driven by
> `sync()` from the panel's plain callbacks."*

So: the islands throw when driven from an owned scope → therefore they must be built in a
`queueMicrotask` (`main.tsx:834`) and driven from plain callbacks → therefore five hand-called `sync*`
functions (**F2**) → therefore machine state must be readable in the same tick it is written (**F1**)
→ therefore `liveSignal`. **One constraint generated both bug classes.**

But that constraint is **opt-out-able**, and we already know how. The islands' internal signals are
plain `createSignal`s (`aiui-dev-overlay/src/multimodal/keymap-ui.tsx:140,141,193`;
`preview.tsx:248`). Adding `{ ownedWrite: true }` to those four declarations should let the panel
drive the islands from a `createEffect` — at which point the five `sync*` functions collapse into
effects, the ~34 call sites vanish, and the same-tick read pressure that `liveSignal` and the
control-mirrors exist to relieve largely evaporates. Note too that the throw is a **dev-only
assertion** (absent from `prod.js`): *the entire panel architecture was shaped by a development-mode
guard.*

*(Reasoned, not measured — this is the highest-value item to prototype. The islands may also write
during construction in ways that need `untrack`, and `preview.tsx:237-254` drives `setPieces` through
an imperative method. Budget an hour to falsify it before committing to §6/M3.)*

The machine also has **no single transition function**: phase changes happen in `enterPhaseTurn`,
`leavePhaseTurn`, `disarm`, `leaderDispatch`, and an `engine.onEvent` handler — each individually
responsible for remembering five sync obligations. STATUS.md's own §4.1 (*"Make the machine real"*)
is the right instinct.

### 5c · The library defects

**`control.set(updater)` loses same-tick chained updates.** *(Measured: `c.set(v=>v+1)` twice →
**1**, where a bare signal correctly gives **2**.)* `packages/aiui-viz/src/control.ts:260-266`
re-implements the functional-update path instead of delegating to Solid's setter:

```ts
const set = ((next: T | ((prev: T) => T)) => {
  const resolved = typeof next === "function" ? (next as (prev: T) => T)(box.get()) : (next as T);
  //                                                                    ^^^^^^^^^ untracked → STALE
  const valid = validate(resolved);
  box.set(valid as Exclude<T, Function>);
  return valid;
}) as Setter<T>;
```

By resolving the updater against `box.get()`, it discards Solid's own pending-value resolution — so
the second of two synchronous updates silently overwrites the first instead of building on it.
**`control` is the primitive we recommend most, and here it is strictly *less* safe than the raw
signal it wraps.** Exposed at `demos/walkthrough/src/model/keys.ts:39-40`
(`kappa.set((v) => v + step)` on arrow keys — two keypresses in one frame, one silently lost) and by
any agent action calling a control updater twice.

*Fix:* pass the updater through — resolve `validate` inside the function handed to `box.set`.

**`control` / `durableSignal` have no read-your-own-writes and no warning.** See R3. The defect is in
the **library**, not the panel: any future app with a dispatch path inherits it.

### 5d · The other live bug: the aztec player under-advances

`demos/gallery/src/pages/aztec/store.ts:144-158`, inside a `requestAnimationFrame` tick (an inbound
boundary):

```ts
while (acc >= interval) {
  acc -= interval;
  const cur = frameIndex.get();      // ← iteration 2 reads the PRE-WRITE value
  if (cur < edge) frameIndex.set(cur + 1);
  else { acc = 0; break; }
}
```

`frameIndex` is a `durableSignal` → a bare Solid signal → the read is untracked. The loop drains
`acc` correctly but **advances the playhead by at most one frame per rAF tick**, no matter how many
intervals elapsed. Symptom: at high `fps`, or after any frame stutter, playback is silently slower
than requested — on the very signal `aztec/NOTES.md:53` singles out as the one that bit them. They
fixed the `seek` tool and left the player.

It evades textual detection because the `get()` *precedes* the `set()` on the page; the staleness
comes from the *next* loop iteration. *Fix:* track the index in a local (`let cur = frameIndex.get()`
outside the loop, increment the local, one `set` at the end) — the §6/M1 cure.

### 5e · The overlay

`aiui-dev-overlay` is majority vanilla DOM (15 files use `document.createElement`; 6 import
`solid-js`), with Solid-inside wrapped in imperative `api` shims that expose setters to non-Solid
callers (`ui/widget.tsx:249,411-413`; `advanced-config.tsx:432`). Same shape as the panel, smaller
blast radius. This is consistent with the standing intent to port the overlay to Solid; that port
should adopt §6 rather than the panel's conventions.

---

## 6 · Mitigations

### M0 · The rule (replaces the folklore)

> **A signal write is a transaction. It commits at the next microtask. The reactive graph is the only
> reader of your writes.**
>
> Corollaries the current docs omit:
> - It applies to **every** synchronous read-after-write — not just tools and tests.
> - It applies to **derived** values too: a memo over a value you just wrote is also stale.
> - Reads **inside** the graph (memos, effect computes, JSX, cell `deps`) are always fine. *This is
>   why the demos are safe* — and saying so is what makes the rule teachable instead of scary.
> - `control()`, `durableSignal()`, and `createStore()` all have these semantics.

### M1 · Don't read back — free, kills most sites

Compute the value first and branch on the **local**; or use the setter's return value.

```ts
const next = !videoOn.get();   // compute FIRST
videoOn.set(next);
if (next) startSampling();     // branch on the LOCAL
```

This is `dropdown.tsx:44-50`, already in the tree. It needs no primitive, no import, and no
discipline beyond "name the value." Most of the seven bites die here. **Highest ratio of bugs fixed
to risk incurred.**

### M2 · `flush()` at inbound boundaries — cheap, mechanical

Wrap the writes at every point where the outside world calls in: `leaderDispatch`, the `chrome.*`
message handlers, `engine.onEvent`, the agent tools' `run()`, the rAF ticks.

```ts
const dispatch = (event: Event) => flush(() => { /* writes only */ });
// after this returns: direct reads, derived memos, and effect-driven islands are ALL current.
```

Use this where a flow genuinely must observe its own writes. Prefer M1 where it suffices — `flush()`
is a commit, and committing on every keystroke is a (small) cost. But it is the *correct* tool, it is
what Solid ships for this, and it is honest about what it does.

### M3 · Effects at outbound boundaries — deletes F2 as a category

Give the islands' internal signals `{ ownedWrite: true }` (four declarations, §5b), then replace the
five hand-called `sync*` functions with effects over derived claims:

```ts
createEffect(() => capsFor(phase.get(), inkOn(), videoOn.get()), (caps) => islands.paint(caps));
```

`main.tsx:762` already *says* the right thing — *"The video claim, **derived** like ink/stream"* — and
then hand-pushes it. Make the derivation real and the obligation cannot be forgotten. Combined with
M2, `flush(fn)` repaints the islands synchronously as part of the dispatch, so imperative code
downstream of a dispatch still sees an up-to-date DOM.

### M4 · Fix `control.set(updater)` — a real bug, ~3 lines (§5c)

### M5 · Delete `liveSignal`

It is a partial fix that conceals the general one, it has been copied twice more, and its use as a
control-mirror manufactures the permanent-desync bug in §4.2. Reduce to a deprecated alias for one
release if that eases the migration, then remove. The `hot-graph.ts` usage may stay under its
"genuinely external state" justification (§4, residue) — but it should *say* that, not cite F1.

### M6 · A dev-mode assertion — the pit of success ⭐

**This is the recommendation I would implement first**, because R1 says the bug is *regenerated* by
LLM priors on every new file, and no document can outrank a prior. Something must **fail loudly**.

We own `control()` and `durableSignal()`. In dev, have `.get()` detect the exact hazard and shout:

```ts
// sketch — inside ControlBox.get()
if (import.meta.env.DEV && getObserver() === null && wroteThisTick) {
  console.error(
    `[aiui] "${name}" was written earlier in this same tick and is being read outside a reactive ` +
    `scope — you are reading the PRE-WRITE value. Use the value you wrote, or flush() first. ` +
    `See docs/guide/frontend-hard-won.md#write-semantics`,
  );
}
```

`getObserver()` is exported from `solid-js` and is `null` exactly at an imperative boundary (§2).
`wroteThisTick` is a flag set in `.set()` and cleared in a `queueMicrotask`. Roughly ten lines. It
converts a silent wrong-branch into a named error at the precise call site, for **every** future
occurrence, in the primitive our app code actually uses. Consider extending the same check to
`liveSignal`'s eventual replacement and to `durableSignal`.

*(A syntactic lint rule — flag `setX(…)` followed by `x()` in one function body — is a reasonable
supplement, but it cannot see the derived-read or cross-function cases, which is where the surviving
bugs are. The runtime guard can.)*

### M7 · A semantics-pin test

Land the probe suite (§8) as a permanent test. If a future Solid beta restores eager writes — or
changes the boundary rule — we want a red test, not a silent behavior change under 1,480 lines of
machine code.

### M8 · Fix the teaching

- `docs/guide/frontend-hard-won.md:25-29`, `frontend-user-guide.md:554-557`, and **`SKILL.md:161`**
  (the one agents actually load): replace *"where it bites: tools and tests"* with **M0**. Add
  `flush()`. Add "derived values are stale too." Add "reads inside the graph are always fine."
- Add the **imperative boundary** section (§2) to `frontend-for-agents.md` — the repo has no
  vocabulary for this today, which is precisely why the panel had nothing to copy (R4).
- Delete the "heavily-subscribed signal" folklore at `demos/gallery/src/pages/aztec/NOTES.md:53-54`.
  The behavior is deterministic and has nothing to do with subscriber count; the real reason
  `targetN` "looked fresh" is that it was never written in that flow.
- Per the standing convention that `docs/guide/frontend-*.md` is the source of truth and the skill is
  a digest, re-sync the skill after editing the guide.

### Anti-mitigations — things that look right and are not

**A · A `machineStore()` built on `createStore`.** STATUS.md §4.2 proposes *"a `machineStore()` that
wraps controls/durables and exposes only read-your-writes accessors."* The instinct (make the wrong
default unwritable) is right; the substrate is wrong. **Measured: `createStore` has identical deferred
semantics** — a store write and a store-derived memo are *both* stale before the flush. Built on
`createStore`, `machineStore` would fix nothing. Built on `flush()`, it becomes M2 with a nicer face —
which is fine, and is the version worth building:

```ts
const m = machine(initial, reduce);
m.send(event);      // internally: flush(() => setState(reduce(state, event)))
// after send() returns: state, every derived memo, and every effect-driven island are current.
```

**B · "Make everything async."** A microtask does commit (**measured**), so `async dispatch` +
`await` would "work." I recommend against it as the primary cure:
- The `await` becomes **load-bearing while looking incidental**. Any refactor that removes it silently
  reintroduces the bug — a strictly worse failure mode than the one we have, because it is invisible
  at the call site.
- It makes every transition **non-atomic**: a second keyboard event can arrive during the await and
  interleave with a half-applied dispatch, on a machine with no lock. We would trade a visible bug
  class for a re-entrancy bug class.
- It is viral: async dispatch forces async callers all the way up.

**The real axis is not sync-versus-async. It is derive-versus-read-back.** Solid 2.0 does not want
async; it wants you to stop reading state back. Where you cannot, it wants you to **commit**.

---

## 7 · Sequencing

1. **M6** (dev assertion) + **M4** (`control.set` fix) + **M7** (pin test) — library-local, no app
   churn, and M6 starts catching bite #8 immediately. Ship together.
2. **M8** (docs + skill) — cheap, and it stops the wrong prior from being *confirmed* by our own
   material.
3. **Fix the three live bugs**: the video-cap desync (§4.2), the aztec player (§5d), the walkthrough
   `kappa` updater (falls out of M4).
4. **Prototype M3's premise** — one island, one `ownedWrite`, one effect. An hour. Either it works
   and the panel gets much smaller, or it doesn't and we learn why before committing.
5. **M1/M2 sweep of `main.tsx`** — read-back removal, then `flush()` at the surviving boundaries.
6. **M5** — delete `liveSignal` once nothing needs it.
7. **The machine rewrite** (STATUS.md §4.1: one transition function, derived claims, effects out) —
   now a *design* task rather than a bug-fix task, because steps 1–6 removed the bugs that were
   forcing it.

Steps 1–3 are strictly additive and low-risk. Step 4 is the decision point for how much of the panel
gets rewritten.

---

## 8 · Verification — what was actually measured

Probe suite against `solid-js@2.0.0-beta.15` (jsdom, the extension's own vitest config; the
scratchpad copy should land as M7):

| # | Claim | Result |
| --- | --- | --- |
| 1 | Read after write, no reactive context | **stale** (`getOwner()` is `null`) |
| 2 | Read after write, real DOM event handler | **stale** |
| 3 | Write inside `createRoot` body / memo compute | **throws** `REACTIVE_WRITE_IN_OWNED_SCOPE` |
| 4 | Write inside an effect *handler* | allowed; read-back **stale** + `STRICT_READ_UNTRACKED` |
| 5 | `flush()` after a write | **fresh** |
| 6 | `flush(fn)` wrapping the write | **fresh** immediately after |
| 7 | `flush(fn)` runs **effect handlers** synchronously | **yes** — the island repaints before the next line |
| 8 | One `await` (microtask) after a write | **fresh** (`setTimeout 0` is over-strong) |
| 9 | `liveSignal` → `createMemo` read, same tick | **STALE** — the fatal result |
| 10 | `liveSignal` → memo → memo, same tick | **STALE** |
| 11 | `createStore` write + store-derived memo, same tick | **both stale** (kills anti-mitigation A) |
| 12 | Bare signal, two `set(v => v+1)` in one tick | **2** (so `live-signal.test.ts:25-30` pins a non-feature) |
| 13 | `control.set(v => v+1)` twice in one tick | **1** — the second update is **lost** (§5c) |
| 14 | Setter's return value | the **new** value, while `x()` still reads the old |
| 15 | `solid-js@1.9.14`: read after write | **`"armed"`** — 1.x *had* read-your-own-writes |
| 16 | `flush` exported from `solid-js` prod build | **yes** (`typeof m.flush === "function"`) |
| 17 | `REACTIVE_WRITE_IN_OWNED_SCOPE` in `prod.js` | **absent** — a dev-only assertion |

Explicitly **not** measured, and flagged as such above: that `{ ownedWrite: true }` on the four island
signals is sufficient to drive them from an effect (§5b — prototype first); and that `liveSignal`
tears snapshots under transitions/optimistic updates (§4.4 — reasoned from the source, not
demonstrated).

---

## Open questions

1. **Is `flush()` on every keystroke acceptable?** It forces a synchronous commit of the whole
   pending queue. For a keyboard dispatch at human speed, certainly. For the rAF player loop or the
   60 Hz REC meter, M1 (don't read back) is the right cure and `flush()` should be avoided. Worth a
   measurement if any boundary turns out to be hot.
2. **Should `control()` simply *be* safe?** Rather than warn (M6), `control.get()` could `flush()`
   when read outside a reactive scope. That would make the trap unspringable — at the cost of a
   hidden commit with surprising timing, and of diverging from Solid's semantics in our own
   primitive. I lean toward **warn, don't fix**: silent magic is what got us here. Worth an explicit
   decision.
3. **What replaces `liveSignal` in the barrel export?** Nothing, if M1–M3 land. But if a
   `machine()` helper (anti-mitigation A, the `flush()`-based version) proves useful, it is the
   natural successor and belongs in `aiui-viz` next to `control`.
4. **Does the overlay port adopt this first?** The overlay is about to be rewritten in Solid. It
   would be a cheaper place to prove the M2+M3 pattern than the panel — and it would give the repo
   the missing reference implementation of a correct imperative boundary (R4).
