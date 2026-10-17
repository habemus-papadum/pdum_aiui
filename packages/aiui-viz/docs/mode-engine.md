# The mode engine

Status: design note, 2026-10-17. Three parts: **the ideas** (a first read — what each concept is
for, with analogies to systems that solve the same problem), **the contract** of
`@habemus-papadum/aiui-viz/mode-engine` (`src/mode-engine/`: `engine.ts`, `claims.ts`,
`effect.ts`) with its two sister subpaths `…/keys` (the key layer) and `…/live-text`
(`LiveDiffText`, `wordDiff`), and **the record** of what was retired around it on 2026-10-17 and
why. The pieces came out of two generations of intent client
(the overlay and the panel) that have since moved to another repository; the history that
produced them is in git: the modeling exercise that specified the engine
(`git show e90cddf2:docs/proposals/intent-client/01-mode-engine.md`) and the retrospective on the
overlay's modal system (`git show 3b75c24a:packages/aiui-viz/handoff/modal-interaction-lessons.md`).
Consumers today: the aiui-audio hub (`packages/aiui-audio/src/hub.ts`: one engine, one claim),
aiui-slides and demos/walkthrough (the key layer), demos/audio (live text).

## Part one — the ideas

Read this part first; it explains why the contract below has the shape it has. Most sections end
with the analogy that fits best, and with where it stops fitting.

### The problem: a UI driven from every direction at once

The engine came out of two interactive clients whose "modes" were toggled by keyboard (a leader
grammar, a global shortcut whose meaning depended on state), by mouse (bar buttons that had to do
exactly what the key did), by an agent (a voice tool writing `videoOn`), and by the world (a turn
closing, a window blur, a tab disappearing, a socket dropping). Some axes were independent — ink,
video and talk could all be on at once. Some were exclusive within themselves — dictation,
hands-free and realtime were one choice. Some were hierarchical with an escape ladder —
`disarmed ⊂ armed ⊂ turn ⊂ turn.tweak`, where Esc steps out one level. And many states were
"neither on nor off": a microphone *granted but idle*, a tab stream *warming*, video *on but not
sampling*. The inventory ran to about forty-six flags across the two apps, five hand-called
`sync*` functions invoked from about thirty sites, and two separate stores for "armed". The bugs
clustered in two places: fragments of an operation's progress written back into ad-hoc flags, and
state written from one call site and read back, stale, from another in the same tick.

This is the problem Harel statecharts were invented for — orthogonal regions and hierarchy — and
the problem the Elm architecture and Redux solved on the write side: one pure function is the only
thing that changes the model. The engine is a statechart subsetted to what those apps needed, plus
a declarative resource reconciler for the asynchronous half that statecharts leave to the host.

### The one idea: a mode is a setting plus an operation

Everything else follows from a single split. A **setting** is what the user chose: standing,
often durable across reloads, often visible to an agent (`capture: on`, `talk: dictation`). An
**operation** is what the world is currently doing about that choice: derived from the settings
and the facts, transient, usually asynchronous, and always *in some phase* — pending, active,
failed. The "neither on nor off" states are not exotic values of the setting; they are the phase
of the operation. Settings live in **regions**. Operations are **claims**. The rule that keeps the
split honest: no code ever stores a fragment of operation status in a flag; it derives it.

**Analogy.** Kubernetes separates a resource's `spec` (desired, what someone asked for) from its
`status` (observed, what the controller has achieved so far). `replicas: 3` is a setting; three
running pods are the operation; "2/3 ready" is its status, computed from the world and never
edited by hand. The controller loop converges one to the other. Regions are the spec, claims are
the controllers, claim status is the status subresource.

### Regions — the settings

A region is one named axis of the state with a value of its own; the engine's state is the
product of all regions, a frozen plain object. Because each region is an enum (or a boolean),
exclusion *inside* a region costs nothing, and orthogonality *between* regions is true by
construction — there is no way to express "ink and video cannot both be on" except by writing an
explicit cross-region rule, which is the point. Four kinds:

- **`toggle()`** — a boolean standing flag (capture on, help open).
- **`choice(values)`** — exactly one of a fixed list the spec enumerates (talk: off · dictation ·
  hands-free · realtime). The list is frozen with the spec.
- **`openChoice(accept)`** — one of a set the spec *cannot* enumerate: registered device ids, open
  tabs. The host supplies a predicate, consulted at every write and read live. A value that stops
  being acceptable stays as state until the next write — states are not revalidated, writes are.
- **`ladder(rungs)`** — exclusive *and ordered*. Esc walks it downward one rung per press, never
  below its `escFloor` (so Esc can cancel a turn without disarming; disarming stays a deliberate
  command). A ladder is a statechart's nesting flattened to a list: the order *is* the hierarchy.

Every region has an `initial`, which is also what Esc and blur restore. Regions may carry
`durable`, `agent` and `description` flags; the core only carries them — a host adapter acts on
them, and none in this repo does today.

**Analogy.** In a statechart the regions are the AND-decomposition (parallel states) and a ladder
is one OR-decomposition (nested states) written as a column. In Emacs, minor modes are toggles and
the major mode is a choice. Vim's normal/insert/visual is a ladder-like exclusive axis — but Vim's
Esc jumps straight to normal from anywhere, while this engine's Esc deliberately steps *one* rung,
because the convention here is that Esc is never destructive beyond the scope you are in.

### Context — facts, not choices

Tab identity, a granted stream, a connection, the version of a source: inputs the world supplies,
not settings anyone chose. They sit beside the state as `context`. No command sets them, they are
never durable, Esc and blur never touch them — but claims derive from them, so `setContext`
notifies subscribers with a `context` event and the claims reconcile. The test for which side a
value belongs on: *would a user ever choose this?* If not, it is context. Putting a fact in a
region would hand it Esc, blur and durability semantics that mean nothing for it.

**Analogy.** Elm's `subscriptions` deliver outside facts as messages through `update`; here the
facts bypass the reducer entirely and act as the environment the reducer and the claims read.
Closer still: a controller's view of the cluster — observed, not requested.

### Commands — the only writers

`dispatch(command, payload)` runs a pure reducer `(state, payload, ctx) → patch` and commits the
result. Every source of change funnels into it: the key resolver's answer, a button tap
(synthesized through the same resolver, so a button cannot drift from its key), an agent's write
through a control bridge, a system event through an `on` binding, a test. Built in for every spec:
a `set:<region>` setter per region, `escape` and `blur`. An unknown command throws, loudly —
commands are code, not user input. When nothing but the reducer writes machine state, the
write-then-read-back trap (a signal written in one place and read, stale, in another during the
same tick) has no call sites left to occur at; `state()` is a frozen object that is never stale,
from any scope.

**Excludes** are cross-region implications — "entering realtime turns the linter off" — declared
once and applied after *every* command in declaration order, a single pass, no fixpoint. They also
run over the initial state, so a persisted value cannot resurrect a forbidden combination. The
discipline: an exclude is for an invariant that must hold *whichever* command moved the state.
"Disarm turns everything off" is not an invariant; it is what the `disarm` command's reduction
does.

**Escape and blur** are resolved mechanically from the spec, not written per app. `escOrder` ranks
the regions; one Esc steps the highest-ranked region that is not at its base out one level (a
toggle to off, a choice to its initial, a ladder one rung down to its floor). A press with
everything at base is a no-op the host may pass to the page. Blur is Esc's page-focus sibling,
restricted to regions that opted in (`blurExits`, `blurExitsFrom`) — modes whose purpose is a
round trip out of the page, where coming back must not resume them — and it steps every opted
region in one dispatch.

**Availability is derived, and it is a gate.** `canDispatch(command, payload)` dry-runs the same
reducer-plus-excludes computation and asks "would anything change?" — so `set:talk` with the
current value reads as unavailable, and so does a reduction the excludes would immediately
revert. `available` overrides exist for *verbs* (commands that are pure effects and move no
region, which would otherwise derive to "never") and for gates on context facts. And `dispatch`
itself refuses an unavailable command and traces the refusal: a button, a key, an agent's write
and a recovered turn all arrive at the same sink, so the sink is the only place a rule can
actually hold.

**Analogy.** The reducer is Elm's `update` or a Redux reducer; the patch *is* the write. Excludes
are database `CHECK` constraints with a fix-up action rather than a rejection — but deliberately
not a constraint solver: there is no fixpoint, and declaration order is the author's
responsibility. `canDispatch` is the command pattern's `CanExecute` (WPF, Qt actions) with the
answer derived from the reducer instead of hand-maintained next to each button.

### The commit path

State advances, then every subscriber is notified inside the host's `commit` hook (a plain call
by default; a reactive host may pass its synchronous-commit primitive). Work started *from inside*
a commit — a subscriber dispatching, a subscriber changing the context — is queued and runs after
the current commit, so nested work never interleaves with a notify loop. A subscriber that throws
is reported and the loop continues, so every subscriber hears every commit in order and the queue
still drains. Every dispatch is traced through `onDispatch`, no-ops and refusals included.

Together these give single-writer linearity: the sequence of committed states is a log, every
subscriber reads the same log in the same order, and the notified world never lags the committed
state. The trace is the log made visible — the retrospective's "mode changes should be events so
traces show them and replay reproduces them".

**Analogy.** A database commit whose triggers cannot re-enter the transaction: anything a trigger
wants to do is queued as the next transaction. Redux enforces the same rule by throwing when a
reducer dispatches; this engine queues instead, so the subscriber's intent is kept, just ordered.

### Claims — the operations

A claim is three functions. `derive(state, ctx)` returns the *desired operation* — a value keyed by
identity ("capture from source 3", "sampling at 1 fps") — or `null` when nothing is desired.
`acquire(desire, signal)` brings it into being and returns the *actual* (a handle, a release
function). `release(actual, desire)` tears it down. `createClaims` diffs desired against actual
after every commit (wire `reconcile` to `engine.subscribe`, unconditionally — it is cheap when
nothing changed) and drives the appliers. Each claim carries a derived **status**: `idle`,
`pending`, `active`, `error`, `stale`. That status is the "neither on nor off" state, displayable
and never stored.

The rules, each with the failure it prevents:

- **One claim is strictly sequential** — release completes before the next acquire starts. A
  device cannot be held twice; two claims are independent.
- **A desire change supersedes an in-flight acquire at once.** The acquire's `AbortSignal` fires
  the moment the desire moves, so a driver listening on it releases what it holds — a pending
  `getUserMedia` stops its tracks the moment they land, not sixty seconds later at the ceiling. A
  value that lands anyway is released, never adopted (`stale`). The newest desire is applied next,
  *even when it is null*: retraction is a desire like any other.
- **An error parks the claim** in `error` until the desire changes or `retry(name)` is called — no
  hot retry loops. An acquire that fails because we aborted it is not a fault.
- **A throwing release is reported** and the actual dropped anyway; a release must not wedge the
  claim.

There are no entry/exit hooks anywhere in the engine, on purpose. The retrospective's durable fix
for a stranded overlay was not better transition bookkeeping but a per-event assertion from state:
a missed transition then costs one reconcile, not a wedged UI. Claims are that assertion,
generalised to asynchronous acquire/release with status.

**Analogy.** This is the Kubernetes controller loop: desired versus actual, diffed on every
change, converged, with a status the UI can show. It is also React's `useEffect` with a dependency
array and a cleanup — `derive` is the dependency array computed as a value, `release` is the
cleanup — plus the three things `useEffect` lacks: a status, strict sequencing, and cancellation
of the in-flight run. RxJS users will recognise supersession as `switchMap`: the newest inner
operation wins and the previous one is unsubscribed. The distinction the Kubernetes world draws
between *level-triggered* and *edge-triggered* controllers is exactly the engine's position on
effects: reconcile from the current state, never from the transition that led there.

### `guardedEffect` — one asynchronous step under three disciplines

Under every acquire sits `guardedEffect(options, run)`. It never rejects; every outcome is data
the caller folds: `ok`, `stale`, `timeout`, `aborted`, `error`.

- **Completion-time revalidation.** `stillValid` is checked when the result *arrives*, never at
  launch — a screenshot that resolves seconds after a share picker can land in a turn that was
  already sent. Launch-time checks are worthless for slow effects.
- **A ceiling.** `ceilingMs` aborts the run's signal and resolves `timeout`. Timeouts are part of
  the effect, not the caller's problem: no mode may wedge on a promise ("Enter waits for a
  transcript that will never come").
- **An outer abort.** The caller's `signal` (a superseded claim) is forwarded to the run at once,
  and a run that then fails resolves `aborted`, not `error` — the caller asked.

**Analogy.** Go's `context.Context` threads cancellation and a deadline through every call; the
revalidation step is optimistic concurrency — compare the version at commit, not at start. The
claims runtime literally does this with a per-claim `generation` counter.

### The key layer (`…/keys`)

A surface's keyboard is a **stack of layers** resolved top-down by a pure function,
`resolveKey(stack, state, key, phase, repeat)`. A binding answers with a command, `"swallow"`
(claimed, do nothing) or `"pass"`; a layer that binds nothing for a key answers with its mandatory
`fallback`, so claim-or-pass is exhaustive by construction. `swallow` is the inert command that
stops a held key's repeats from scrolling the page while an acquisition is still in flight — the
bug behind it was a keymap whose default answer was `undefined`. A binding that explicitly answers
`"pass"` skips its own layer's fallback and falls through to the layers below (an explicit pass is
a choice). Layers activate on a state predicate, so the stack itself is static data: a config strip
pushes a layer that claims three keys while everything beneath keeps its meaning — a *layer*, not a
mode.

`installKeys` is the single capture-phase listener on the document; it yields to typing targets
(composedPath-aware, so inputs inside shadow DOM count) and components never fight it. `keyHints`
derives the displayed cheat sheet from the same table with the same shadowing, so the keymap on
screen and the keymap in force are one table; a UI tap executes by synthesizing its binding's first
key through the resolver (`tapKey`), so a button cannot drift from its key. The layer never
depended on the engine: aiui-slides dispatches into a six-case switch of its own.

**Analogy.** Emacs keymaps: minor-mode maps shadow the major-mode map, which shadows the global
map, resolved in precedence order, and binding a key to `ignore` is `swallow`. CSS specificity is
the other everyday instance of "the first winning rule shadows the rest".

### Live text (`…/live-text`)

`wordDiff(before, after)` is a word-level longest-common-subsequence diff merged into runs;
`LiveDiffText` is a live line where an *extension* (new words appended) renders instantly and a
*revision* flashes the diff, then settles — the anti-strobe rule: only rewrites animate. Two tempo
constants (`LIVE_FLASH_MS` for a stream, `SETTLE_FLASH_MS` for a discrete patch) keep every aiui
surface animating at one speed, because the moment two surfaces animate change differently, users
stop trusting either. The run classes are `aiui-diff-del` / `aiui-diff-add`; the surface owns the
CSS.

**Analogy.** `git diff --word-diff`, applied live to a transcript being revised in front of you.

### Worked example: the aiui-audio hub

The one in-repo consumer (`packages/aiui-audio/src/hub.ts`) shows the pieces fitting:

```ts
regions: {
  capture: toggle(),  parked: toggle(),  outputMuted: toggle(),
  input: openChoice(registered(inputs)),      // legal = "" or a registered endpoint id
  temporary: openChoice(registered(inputs)),
  output: openChoice(registered(outputs)),
},
commands: { start, stop, select, temporary, park, resume, output, mute },   // each returns a patch
context: { sourceVersion: 0 }
```

One claim, `capture`: `derive` is `state.capture && !disposed ? ctx.sourceVersion : null`;
`acquire` calls the driver's capture with the claim's signal and returns the release function;
`release` calls it; the ceiling is sixty seconds. `onStatus` folds the claim's phase into the
hub's snapshot — `pending` becomes `"starting"`, `active` becomes `"active"`, `error` carries the
message — which is the only place "starting" exists: nobody stores it. The hub's one subscriber
runs `claims.reconcile()`, re-derives the audio route, and asserts each output element's muted
flag from state (render as reconciliation, for imperative DOM).

Changing the microphone is instructive. `start(source)` does not dispatch a "restart" command: it
bumps `sourceVersion`, calls `setContext`, dispatches `start`, and calls `retry("capture")`. The
desire is the version, so the version change makes the reconciler release the old capture and
acquire the new one in order; the source itself is a fact about the world, not a choice the
reducer owns. A capture that ends on its own (the driver's end callback) dispatches `stop`, and the
`capture` region follows the world.

### What it is, and what it is not

A statechart, subsetted: parallel regions, hierarchy as ladders, event-to-command bindings — and
no history states, no nested parallel machines, no delayed transitions, no actor spawning. A
statechart library was considered and rejected, narrowly: the chart semantics here are small, and
the value is in the integrations — claims with status over guarded effects, the key layer, the
commit discipline, the trace — which are bespoke either way. Because the spec is data, swapping a
library into the kernel later would be a contained change. The engine is framework-free (no Solid,
no DOM: it runs in node, workers and tests as plain data and functions); a reactive host mirrors
`state()` into its own system from `subscribe`, and the retired Solid adapter in Part three is the
shape that mirror took.

### Where to look

The tests are the executable version of this part, named by concept: `engine.test.ts`
(the reducer table · excludes · escape · blur · bindings · commit and trace · canDispatch · spec
validation · openChoice · immutability), `claims.test.ts` (derive → acquire → active · desire
changes · failure · dispose), `effect.test.ts`. The two documents the engine grew out of are in git:
the modeling exercise that inventoried the phenomena and specified the six concepts
(`git show e90cddf2:docs/proposals/intent-client/01-mode-engine.md`), and the retrospective whose
eleven rules the pieces encode (`git show 3b75c24a:packages/aiui-viz/handoff/modal-interaction-lessons.md`).

## Part two — the contract

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

## Part three — retired 2026-10-17

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
