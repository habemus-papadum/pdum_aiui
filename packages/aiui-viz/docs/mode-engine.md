# The mode engine

Status: design note, 2026-10-17. The contract of `@habemus-papadum/aiui-viz/mode-engine`
(`src/mode-engine/`: `engine.ts`, `claims.ts`, `effect.ts`), with its two sister subpaths
`…/keys` (the key layer) and `…/live-text` (`LiveDiffText`, `wordDiff`), and the record of what was
retired around it on 2026-10-17 and why. The pieces came out of two generations of intent client
(the overlay and the panel) that have since moved to another repository; the history that
produced them is in git: the modeling exercise that specified the engine
(`git show e90cddf2:docs/proposals/intent-client/01-mode-engine.md`) and the retrospective on the
overlay's modal system (`git show 3b75c24a:packages/aiui-viz/handoff/modal-interaction-lessons.md`).
Consumers today: the aiui-audio hub (`packages/aiui-audio/src/hub.ts`: one engine, one claim),
aiui-slides and demos/walkthrough (the key layer), demos/audio (live text).

## Part one — the contract

### The split

Every "mode" is two things. A **setting** is what the user chose: standing, often durable, often
agent-visible (`capture: on`, `talk: dictation`). An **operation** is what the world is doing about
it right now: derived, transient, async (the microphone is being acquired; frames are flowing from
tab 42). The states an inventory keeps finding that are "neither on nor off" — granted but idle,
warming, on but not sampling — are the *status of an operation*, not exotic states of the setting.
Settings live in regions; operations are claims. Nothing stores a fragment of operation status in
an ad-hoc flag.

### Regions, context, commands

- **Regions** are named, independently-valued axes; the state is their product (a frozen plain
  object), so orthogonality is by construction and exclusion inside a region is free. Four kinds:
  `ladder(rungs)` — exclusive and ordered, Esc walks it downward one rung per press, with an
  `escFloor` it never steps below; `toggle()` — a boolean standing flag; `choice(values)` — one of
  a fixed list; `openChoice(accept)` — one of a set the spec cannot enumerate (registered device
  ids), legality decided by the host's predicate at every write, read live. Every region has an
  `initial` (the value Esc and blur restore) and may carry `durable` / `agent` / `description`
  flags — the core only carries them; a host adapter acts on them (none does today, see
  "kept but unused").
- **Context** is the world's facts — tab identity, grants, a source version. Inputs, not choices:
  no command sets them, they are never durable, but claims derive from them, so `setContext`
  notifies subscribers with a `context` event.
- **Commands are the only writers.** `dispatch(command, payload)` runs a pure reducer
  `(state, payload, ctx) → patch`, then the declared cross-region **excludes** in declaration
  order, once — no fixpoint. The excludes also run over the initial state, so a persisted value
  can never resurrect a forbidden combination. `set:<region>` is built in for every region;
  `escape` and `blur` are built in and resolve mechanically from `escOrder` and the regions'
  `blurExits` / `blurExitsFrom`. An `available` entry is a **gate**, not a hint: an unavailable
  command is refused by `dispatch` itself, whatever surface sent it. `on` binds system events to
  commands (`emit(event)`); binding targets are validated at creation like every other name.
- **Availability is derived.** `canDispatch(command, payload)` dry-runs the same computation
  dispatch performs — reducer, excludes, the payload (so `set:x` with the current value is
  `false`) — or defers to the `available` override.
- **The spec is a frozen snapshot.** `createModeEngine` deep-freezes a copy of the spec (regions
  and their lists, excludes and their patches, bindings, gates) and exposes it as `engine.spec`.
  Mutating the caller's arrays afterwards changes nothing; a set that grows at runtime is an
  `openChoice`.

### The commit path

State advances, then every subscriber is notified inside the host's `commit` hook (a plain call by
default; a reactive host passes its synchronous-commit primitive). Three rules keep it linear:

1. Work started from inside a commit **queues**. A dispatch from a subscriber runs after the
   current commit completes; so does the notification for a `setContext` from a subscriber — the
   facts change at once (`context()` reads them), the `context` event waits its turn. Nested work
   never interleaves with a notify loop, whatever the nesting.
2. A **throwing subscriber is reported, not propagated** (`onError`, console.error by default).
   The loop goes on and the queue still drains, so every subscriber hears every commit in order
   and the notified world never lags the committed state.
3. **Every dispatch is traced** through `onDispatch` — no-ops (`changed: []`) and gate refusals
   (`refused: true`) included.

A host mirrors `state()` into whatever it keeps, from `subscribe`. Machine state itself is a plain
frozen object written only by `dispatch`: reading it is never stale, in any tick, from any scope.
That is the structural fix for the write-then-read-back trap the hard-won ledger describes.

### Claims

A claim is `derive: (state, ctx) → desire | null` plus an `acquire(desire, signal)` and an optional
`release(actual, desire)`. `createClaims(specs, { getState, getCtx, onStatus, onError })` returns a
handle whose `reconcile()` is called after every commit (wire it to `engine.subscribe`,
unconditionally — it is cheap when nothing changed). Semantics:

- operations on one claim are strictly sequential (release completes before the next acquire);
  distinct claims are independent;
- a desire change during an in-flight acquire **supersedes** it: the acquire's signal is aborted
  the moment the desire moves (a driver listening on it releases what it holds — a pending
  `getUserMedia` stops its tracks the moment they land, not at the ceiling); a value that lands
  anyway is released, never adopted (`stale`); the newest desire is applied next — the newest
  fold wins, even when it is null;
- an acquire error or ceiling timeout parks the claim in `error` until the desire changes or
  `retry(name)` is called — no hot retry loops; an acquire that fails because we aborted it is not
  a fault;
- release errors are reported and the actual dropped anyway;
- `status(name)` / `statuses()` give `idle | pending | active | error | stale` with the desire
  and error; `dispose()` retracts everything and settles.

`guardedEffect(options, run)` is the primitive under each acquire: completion-time revalidation
(`stillValid`, checked when the result arrives, never at launch), a hard ceiling (`ceilingMs`;
aborts the signal, resolves `timeout`), and an outer `signal` whose abort is forwarded at once
(`aborted`). It never rejects; every outcome is data.

### The key layer (`…/keys`)

A surface's keyboard is a stack of layers resolved top-down by a pure function. A binding answers
with a command, `"swallow"` (claimed, do nothing — the inert answer that stops held-key repeats
from scrolling the page while an acquisition is in flight) or `"pass"`; each layer declares a
`fallback`, so claim-or-pass is exhaustive by construction. `resolveKey` is the resolver,
`keyHints` derives the displayed keymap from the same table with claim shadowing, `installKeys` is
the one capture-phase owner on the document and yields to typing targets (composedPath-aware, so
shadow-DOM inputs count). A UI tap executes by synthesizing its binding's first key through the
same resolver (`tapKey`), so a button can never drift from its key. The key layer never depended
on the engine; slides' dispatch is a six-case switch over its own model.

### Live text (`…/live-text`)

`wordDiff` is the word-level LCS merged into runs; `LiveDiffText` is a live line where extensions
render instantly and revisions flash the diff then settle (`LIVE_FLASH_MS` for a stream,
`SETTLE_FLASH_MS` for a discrete patch). One visual language, one tempo, for "this text changed in
front of you" — the moment two surfaces animate changes differently, users stop trusting either.
Run classes default to `aiui-diff-del` / `aiui-diff-add`; the surface owns the CSS.

### Fixed 2026-10-17

The code review (viz-plan 2026-10, item B) probed the kernel and found these; each fix carries a
regression test in `src/mode-engine/*.test.ts` and `packages/aiui-audio/src/hub.test.ts`:

1. `setContext` from inside a subscriber cleared the outer commit's flag, so a later subscriber's
   dispatch in the same notify loop ran immediately and the remaining listeners saw a newer state
   with an older event. Context notifications now join the same queue as nested dispatches.
2. A throwing listener propagated out of the commit and skipped the queue drain; queued commands
   ran after the *next* unrelated dispatch, in inverted order, with state already advanced.
   Listener failures are now isolated and reported.
3. Supersession did not abort the in-flight acquire's signal — only the ceiling did — although the
   claims header said it did and aiui-audio's capture driver wires its release to that signal; a
   superseded `getUserMedia` was released only after the prompt resolved, bounded by the 60 s
   ceiling. `aim()` now aborts the in-flight controller; `guardedEffect` takes the outer signal.
4. A gate-refused dispatch left no `onDispatch` trace, against the header's "every dispatch".
5. `canDispatch("set:<region>", v)` ignored `v`.
6. `on` binding targets were not validated at creation.
7. The spec was documented as frozen but was not, and the audio hub depended on that: its choice
   regions' legal values were a live array mutated after creation, which worked only because
   `choice()` aliased the array. The spec is now a frozen snapshot and the hub declares
   `openChoice` regions over its endpoint maps.

### Kept, but unused by today's consumers

The hub uses `toggle`, `openChoice`, `state`, `dispatch`, `subscribe`, `setContext`, `context`,
and from claims `derive`/`acquire`/`release`/`ceilingMs`, `onStatus`, `onError`, `reconcile`,
`retry`, `dispose`. Nothing in the repo uses: `ladder` and `choice`; `escape`/`blur` with
`escOrder`, `escFloor`, `blurExits`, `blurExitsFrom`; `excludes`; `on`/`emit`; `available`;
`canDispatch`; `onDispatch`; a custom `commit` hook; `initial` overrides; the `durable` / `agent` /
`description` flags; claims' `same`, `status()`, `statuses()`. They are the regions/esc/excludes
idea the docs teach and the shape a modal app will need again; a later trim should start from this
list, not re-derive it.

## Part two — Retired 2026-10-17

Five pieces left with this change: 676 source and 502 test lines, every one with zero consumers in
this repo after the intent-tool split (`git grep` at `3eab11ce^` shows `aiui-intent-client`,
`aiui-remote-bar` and `aiui-pencil/lab` as their only importers; those apps now live in the
private intent-tool repository). They were created for reasons that will recur, so each entry says
what it was for, what it got right, why it is gone, and what to carry back.

### The bar projection (`bar.ts`)

**For:** the command bar as a render of the mode-engine spec — a tree of caps (`command`, `hint`,
`litWhen`, `enabledWhen`, `showWhen`, `children`) and control-bound widgets (slider / select /
toggle by control name), projected two ways: `barTree` pre-order (a lit parent immediately before
its revealed subtree, so the host brackets them as one shaded group — what the command bar drew)
and `barModel` breadth-first depth rows (the flat config strip). Each cap could carry `remote`
(the subset a bar-only iPad remote may see and tap) and `oracle` (the subset an embedded voice
agent may press), both static and opt-in.

**Right:** labels are stable — the lit highlight carries "engaged", a label swap is a relayout and
a re-read. Enablement is derived from `canDispatch`, never hand-written per cap. A hold cap (push
to talk) stays enabled while *either* half of its gesture applies, because a disabled button
swallows the pointerup and wedges the hold (a paid-for ledger entry). Subset membership is
declared, never deny-listed: a cap added later is excluded until someone opts it in.

**Gone because:** its consumers were the intent client's command bar and the iPad remote bar,
both in the other repo; no in-repo surface renders a bar. The `remote`/`oracle` fields described
departed hosts.

**When it returns:** keep enablement derived and labels fixed; render recomputed projections
position-keyed (`<Repeat>`, not reference-keyed `<For>` over fresh row objects — a re-created node
detaches mid-press, the ledger's "survives its own press" bug); keep subset membership opt-in.
Consider making the bar a *subscriber* that recomputes from `(state, ctx, claims.statuses(),
canDispatch)` after every commit, since the engine now guarantees every subscriber hears every
commit.

### The mode table (`mode.ts`)

**For:** the pre-engine model of one enum-valued mode: `ModeTable<M>` with `initial` and per-mode
`escParent`, `cursor`, `blurExits`, `onEnter`, `onExit`; `escTarget` and `blurExitTarget` read the
columns, `runTransition` fired exit/enter effects.

**Right:** the Esc ladder as a **column, not code** (one-level step-out, never destructive beyond
the scope); blur-exit as declared data for modes whose purpose is a round trip out of the page;
"mode changes SHOULD be events so traces show them and replay reproduces them"; a per-mode cursor
column (cursors are part of the mode contract — a mode-wide crosshair leaking into a config strip
made its chips read as broken buttons).

**Gone because:** `ladder` regions absorbed it — `escParent` became rung order, `blurExits` moved
onto regions — and its transition effects contradicted the kit's own discipline: `onEnter`/
`onExit` is transition bookkeeping, the engine's position is that effects are claims reconciled
per event. Two mode vocabularies were exported side by side; one consumer (the overlay) used only
its lookup columns, and `runTransition` never had one.

**When it returns:** a modal surface that needs a cursor per rung should add a `cursor` column to
the ladder region (or a claim that asserts it), not a second mode model. Resist entry/exit hooks;
if an effect seems to need one, it is a claim whose `derive` returns non-null on that rung.

### The reconciler (`reconcile.ts`)

**For:** render as reconciliation — a list of named, idempotent `SurfaceRule`s asserted FROM state
after every event (an overlay veil, pointer-events routing, a cursor, a ring color), each
isolated in try/catch and reported, so one throwing surface cannot stop the others.

**Right:** the durable fix for the overlay's stranded-veil bug was not better transition
bookkeeping but a per-event assertion ("not armed+ink ⇒ veil hidden") — a missed transition costs
one frame, not a wedged UI. Failure isolation with reporting: a safety net that dies on the first
hole is not one. "For every reachable state, surfaces match the table" is the best property test
of a modal surface.

**Gone because:** it asserted synchronous DOM surfaces from a mode enum, and the real outbound
obligations turned out to be async per-resource claims — `createClaims` is the reconciler
generalized to acquire/release with status. In Solid, JSX from state *is* the reconciliation for
rendered surfaces. The panel never adopted it; the overlay left.

**When it returns:** imperative surfaces outside the reactive graph (a canvas cursor, a veil's
pointer-events, a `body` class) still want a per-commit assertion list. Write it as one engine
subscriber that asserts every surface; the engine's subscriber isolation now supplies the
"reported, never stops the others" half, so the list itself is a loop over idempotent functions.

### The focus tracker (`focus.ts`)

**For:** focus as tracked state — `last()` / `set(focus)` — because `document.activeElement` lies
during transitions (permission pickers steal focus, blur precedes click, shadow retargeting), so
"where does this dictated text fold in?" must read the surface's own record, updated from its
focus/click handlers.

**Right:** naming the pattern so the DOM query never creeps back into decision code; tab order
inside a modal editor is an explicit hop, not native tab flow.

**Gone because:** a two-method closure with no consumer; the value was the name and the rule, and
those live here now.

**When it returns:** a `durableSignal("lastFocus", …)` in the app, written from focus/click
handlers and read by decision code, is the whole implementation.

### The Solid adapter (`mode-solid.ts`, `solidModeEngine`)

**For:** the engine inside a Solid app. It passed `flush` as the engine's commit hook so state
signals, memos and effect-driven projections were current when `dispatch` returned
("flush-committed dispatch"); mirrored `state()`, `context()` and claim statuses into
`ownedWrite` signals written only inside the commit; adopted persisted values for `durable`
regions (an agent region rode its control's storage, a plain one a `mode:<region>` durableSignal)
as the engine's `initial`; and ran the **agent control bridge**: a region with `agent: "name"`
registered a `control()` whose setter dispatched `set:<region>` and whose stored value followed
the region.

**Right:** the single-writer control bridge killed the `videoOnLive` desync class outright — an
agent's `set videoOn true` and the `v` key took the identical path, so the control surface, the
caps and the keymap could no longer disagree. Building the `ControlSpec` as a value before calling
`control(spec)` is the documented shape for legitimate dynamic registration: the aiui compiler
requires literal names on inline `control({ … })` objects and deliberately leaves a non-literal
options expression alone, with the runtime missing-name guard as the backstop. The adoption order
was right: controls and durables created before the engine so their persisted values seed
`initial`, adoption winning over `config.initial`.

**Gone because:** no consumer after the split, and the review found three defects nobody would
have hit without one: `canDispatch` subscribed to the state signal only, so a context-gated
`available` never re-derived in-graph after `setContext`; plain-durable regions were not re-aligned
after the excludes ran over the adopted initial (a `mode:<region>` durable could hold a forbidden
value until the first dispatch), whereas agent regions were; and, plausible but unverified against
`@solidjs/signals@2.0.0-rc.13`, `flush()` nested inside an effect callback is a no-op with a
`FLUSH_IN_EFFECT_CALLBACK` diagnostic and throws `FLUSH_IN_ACTION` inside a Solid `action` body —
a dispatch from an effect would at least warn in dev.

**When it returns:** keep the bridge exactly — setter dispatches, stored value follows the region
via a mirror run from `subscribe`, spec built as a value. Make `canDispatch` read a context signal
as well as the state signal. After creating the engine, write every durable mirror once from the
resolved initial state (the excludes may have moved it). Decide the commit hook deliberately:
either pass `flush` and forbid dispatch from inside effects and actions (route those through a
microtask or an event), or pass no hook and let the `ownedWrite` mirrors commit on Solid's own
schedule — then the "read state() not the signal" rule carries the freshness guarantee, which the
plain frozen object already gives. Verify the rc.13 flush behaviour before choosing; the test file
to resurrect is `git show 96bd2ce4^:packages/aiui-viz/src/mode-solid.test.ts`.

### The lessons the history records

The retrospective's rules, each paid for with a debugging round, still bind any modal surface and
are not written anywhere else in this repo: never disambiguate gestures by event arrival order
(distinct gestures, distinct triggers); a keymap claims or passes every key event, repeats and
keyups included, and claiming must not read state that lags an async action (`swallow`); releases
are unconditional and idempotent; anything keyed to key-*up* needs a window-blur fallback (focus
steals eat keyups); render is reconciliation; async completions re-validate at completion time;
predicates need the semantically right signal, not a proxy (hands-free listening keeps the mic
open through silence — "heard" is its own signal); dangerous global gestures are re-bound inside
editing modes at the keymap level; one event-capture owner that yields to typing targets; cursors
are part of the mode contract; media capture is its own hazard class — `getUserMedia` blocks
forever on an unanswered prompt, `getDisplayMedia` consent is never persisted and its picker
steals focus — so capture goes behind seams that tests can fake. And the convention to hold
constant across apps, because users build muscle memory: Esc steps out one level and is never
destructive beyond that scope; Enter commits the current scope and never reaches through to an
outer scope's destructive action.
