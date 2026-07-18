# The mode engine: a modeling exercise

Part of the [intent-client plan](./README.md). This document does the modeling exercise the
project owner asked for: what *are* modes in our two intent clients, why the current modal kit
cannot hold them, and what a declarative, testable engine that can would look like.

## 1 · What we actually have (the raw phenomena)

Both intent clients are, at their core, mode systems driven from many directions at once:

- **Toggled by keyboard** — the in-turn leader grammar (`i`, `v`, `f`, `t`, `d`, Esc, Enter…),
  the browser-global ⌘B whose meaning is state-dependent (arm+turn / open turn / grant tab /
  resume from tweak).
- **Toggled by mouse** — command-bar caps, which must execute through the *same* resolver as the
  keys so a click can never drift from what the key does (the modal kit already demands this —
  `keys.ts`'s `tapKey` note).
- **Derived from other events** — selection presence follows the page; connection chips follow
  the socket; the ring follows the phase.
- **Triggered by other events** — engine `turnClosed` returns phase to armed; window blur must
  exit some modes and not others; tab close drops that tab's claims; channel reload re-binds.
- **Agent-settable** — `videoOn`, `videoMode`, ink fade are `control()`s an agent can write.
- **Independent (orthogonal)** — ink × video × talk × selection can all be on simultaneously.
- **Mutually exclusive** — within talk, dictation/hands-free/realtime are one choice; video is
  smart *or* constant; phases are exclusive by definition.
- **Hierarchical, with escape** — `disarmed ⊂ armed ⊂ turn`, tweak a submode of turn, help and
  leader-pending transient submodes; Esc steps out one level and is never destructive beyond it.
- **Neither on nor off** — the mic can be *granted but idle*, *acquiring*, *live*, *muted*;
  a tab stream can be *warming*; video can be *on but not sampling* (armed, no turn).
- **Standing vs. per-turn vs. transient** — ink mode outlives turns (durable); the pointer claim
  it implies is per-turn; the help popup is transient.

The full inventory (compiled for this proposal from both conductors, the shared engine, and the
kit) runs to **~46 distinct modes/flags/phases** — 6 on the shared `Engine`, ~23 overlay-side,
~17 panel-side — plus **11 automatic reconciler surfaces** in the overlay and **5 hand-called
claims (+2 more hand-written derivation spots: `leaderState()` at `main.tsx:678-687`, and the
engine-close→phase reconciliation at `main.tsx:520-535`)** in the panel. Two structural facts
from it matter most:

- **The two hosts don't even agree on where truth lives.** The panel's `phase` machine is
  *separate from* the shared engine's own state: `engine.setArmed` is dual-written alongside
  phase changes (`main.tsx:957,971,1000`), the panel's "tweak" is a phase value while
  `engine.mode` stays `"ink"` (`main.tsx:1094`), and turns open by explicit `engine.openTurn()`
  where the overlay opens them implicitly. Two sources of truth for armed/turn is itself a mode
  bug waiting to bite (it already did: "a synchronous engine event stomped a disarm back to
  armed").
- **The overlay's central object is a *derived* mode.** `UiMode` (off · ready · composing ·
  shooting · talking · tweaking · vscode) is never stored — it is a precedence-collapse of five
  stored axes (`ui-mode.ts:39-56`), recomputed per event, and every surface is asserted from it.
  That derivation is the overlay's stability secret, and it is *exactly the thing the modal
  kit cannot express* (§2).

The single most clarifying observation from staring at §13.6, the inventory, and both
conductors:

> **Every "mode" is really two things that the current code muddles: a *setting* (what the user
> chose — standing, often durable, often agent-visible) and an *operation* (what the world is
> doing about it right now — derived, transient, often async).**

`videoOn = true` is a setting. "frames are flowing from tab 42 at 1 fps" is an operation — it
exists only when `phase = turn ∧ videoOn ∧ tab granted`, and it passes through *pending* and
*error* on the way. The "modes that are neither on nor off" are not exotic states of the
setting; they are the **status of the operation**. Once you split the two, the whole inventory
falls into place. The current code stores settings (controls, durables, liveSignals), computes
operations by hand at ~30 call sites (`syncVideo`, `syncInkPointer`, `syncTabStream`…), and
stores *fragments of operation status* back into ad-hoc flags — which is where the bugs breed.

## 2 · Why the current modal kit is necessary but not sufficient

The kit (`aiui-viz/src/modal/`) encodes genuinely hard-won mechanism — keep all of it:

| Module | What it got right | Who actually uses it today |
| --- | --- | --- |
| `mode.ts` | The Esc ladder as a **column, not code**; blur-exit as declared data; "mode changes SHOULD be events so traces show them." | Overlay only — and only its `cursor`/`escParent`/`blurExits` *columns*. **`runTransition` has zero consumers.** |
| `keys.ts` | Keymap **layers** with exhaustive claim-or-pass (`command | "swallow" | "pass"`), pure resolver, table-testable, caps execute via the same resolver. | **Both hosts** — the one fully-adopted module (overlay `keymap.ts:52-59`; panel `leader.ts:56-62`). |
| `reconcile.ts` | **Render is reconciliation**: surfaces asserted from state on every event, never toggled at transitions — "a missed transition costs one frame, not a wedged UI." | **Overlay only** (11 surfaces, `modality.ts:600-705`). The panel — where the F2 bugs live — never adopted it. |
| `effect.ts` | Guarded async effects: completion-time revalidation (`stillValid`), hard ceilings, every outcome data. | **Neither host.** The overlay hand-rolls the completion check it encodes (`capture.ts:152,188`). |
| `focus.ts` | Focus as tracked state. | **No consumer.** |

That usage column is the verdict on "is the modal infrastructure sufficient" in one glance: the
kit's best ideas are half-adopted at best, because adopting them is *manual* — each app must
hand-roll the composition, and the panel (written second, under §13.6 deadline pressure) adopted
only the cheapest module. Two deeper mismatches surfaced by the inventory:

- **The kit models stored modes; the overlay's load-bearing mode is derived.** `ModeTable`
  assumes the app *stores* the mode value (`mode.ts:7-9`); the overlay's `UiMode` is a
  hand-written multi-axis collapse the kit cannot express — so even the kit's one orchestration
  consumer uses it only for lookup columns, not for the machinery.
- **The kit's transition effects contradict its own reconciler.** `runTransition` fires
  `onEnter`/`onExit` at transitions ("a self-transition runs nothing", `mode.ts:86-92`) — the
  *opposite* discipline from `reconcile.ts`'s per-event assertion. The bug ledger is unambiguous
  about which one works: the overlay's stranded-veil bug was *fixed* by moving from
  transition-time effects to per-event reconciliation. The engine below therefore has **no
  entry/exit effects at all** — only claims.

The kit is a bag of *mechanisms* with a deliberate hole in the middle: *"The kit deliberately
does NOT own the mode value."* Each app therefore hand-rolls the composition — and the
composition is exactly where the bugs live:

- `mode.ts` models **one** enum-valued mode variable. Our apps have **many orthogonal regions**
  (phase × ink × video × talk × help × leader…). N tables can't talk to each other: exclusion,
  implication ("disarm forces everything off"), and gating ("sampling requires turn") have no
  home, so they live as imperative code in two ~1,500-line conductors
  (`modality.ts` = 1,597 lines, one function; panel `main.tsx` = 1,480 lines, one component).
- The reconciler asserts *synchronous DOM surfaces from a mode enum*. Our real outbound
  obligations are **async, per-tab claims** (warm a tabCapture stream, inject an ink surface,
  point key capture at tab N) — reconcile.ts has no async story, no diff/actual bookkeeping, no
  status; so the panel hand-wrote five `sync*` functions and calls them at ~30 sites, and
  STATUS.md §F2 records ≥3 bugs from forgotten calls.
- Nothing owns **dispatch**. Key resolver output, cap clicks, agent `control.set`s, engine
  events, and blur handlers each mutate state from their own call site — which is precisely the
  write-then-read-back minefield documented in
  [the write-semantics proposal](../solid-write-semantics-and-the-imperative-boundary.md).
- Nothing **projects**. The command bar, the keymap help, the ring, the agent control surface
  are each hand-maintained views of the same state, synced by hand (the cap-inversion bug
  family).

So the diagnosis for "is the modal infrastructure sufficient?": **the vocabulary is right, the
sentence structure is missing.** The kit has words for ladder, layer, reconcile, guard — and no
grammar that composes them into an application.

## 3 · The model

Six concepts. Everything in §1 reduces to them.

### 3.1 Regions — the settings

A **region** is one named, independently-valued axis of state. Three shapes cover everything we
observed:

```ts
phase:  ladder(["disarmed", "armed", "turn", "turn.tweak"]),  // exclusive, ordered, Esc walks it
ink:    toggle({ durable: true }),                             // boolean standing flag
video:  choice(["off", "smart", "constant"], { durable: true, agent: "videoOn/videoMode" }),
talk:   choice(["off", "dictation", "handsFree", "realtime"]),
help:   toggle({ transient: true, blurExits: true }),
leader: toggle({ transient: true, blurExits: true }),          // pending second key
```

Regions are orthogonal **by construction** — the state is the product. Mutual exclusion inside
a region is free (it's an enum). A region can declare `durable` (survives reload; standing
settings) and `agent` (exposed on the control surface — see §3.6). `ladder` absorbs
`mode.ts`: `escParent` becomes ordering, cursor/blur columns carry over per rung.

### 3.2 Context — facts, not choices

Tab identity, granted-tab set, connection state, selection presence: **inputs the world
supplies**, not settings anyone chose. They enter the engine as data (`ctx`) and participate in
derivations, but no command sets them and they are never durable. Keeping them out of regions is
what keeps the region table honest.

### 3.3 Commands — the only writers

A **command** is a named intention (`"ink"`, `"send"`, `"grantTab"`, `"escape"`, `"disarm"`).
All five input sources funnel into the same entry point:

- keyboard → `resolveKey` (keys.ts, unchanged) → command
- cap click → synthesized through the same resolver (`tapKey`) → command
- agent `control.set` → command (§3.6)
- system events (engine turnClosed, blur, tab close, socket drop) → declared **bindings** to
  commands: `on("turnClosed", "phaseArmed")`, `on("blur", "escapeTransients")`. Bindings also
  cover the *deferred* cases the overlay already has (its `pendingEngine` config applies at
  thread-close, `modality.ts:1001-1013`): a binding may carry a payload captured earlier.
- tests → commands, literally

`dispatch(command, ctx)` is a **pure reducer**: `(state, command, ctx) → state'`. Exclusion
*across* regions ("entering realtime turns dictation off") is sugar compiled into the reducer
(`excludes:` in the spec), applied in declaration order — **no fixpoint, no constraint solver**.
"Disarm abandons everything" is not a standing invariant; it is what the `disarm` command's
reduction *does*. Boring on purpose: a reducer you can table-test.

`escape` is resolved mechanically: the spec declares an **esc order** (help → leader → tweak →
turn-cancel …); Esc steps the highest-ranked non-base region out one level per press —
§13.6's ladder, as a list. Blur is the same resolution filtered to `blurExits` regions.

The runtime wrapper commits atomically at the imperative boundary — `flush(() => apply(state'))`
— so by the time `dispatch` returns, every derived value and every effect-driven projection is
current. (This is mitigation M2 of the write-semantics proposal, given one home. The engine is
*the* structural fix for that bug class: when nothing but the reducer writes machine state,
"write then read back" has no call sites left to occur at.)

### 3.4 Claims — the operations, derived

A **claim** is a pure function from (regions, ctx) to a *desired operation*, keyed by identity:

```ts
claims: {
  inkPointer:  (s, ctx) => s.phase === "turn" && s.ink && ctx.grantedTab ? { tab: ctx.grantedTab } : null,
  tabStream:   (s, ctx) => s.phase === "turn" && ctx.grantedTab ? { tab: ctx.grantedTab } : null,
  videoSample: (s, ctx) => s.phase === "turn" && s.video !== "off" && ctx.grantedTab
                             ? { tab: ctx.grantedTab, cadence: s.video } : null,
  keyRouting:  (s) => s.phase === "turn" && s.phase !== "turn.tweak" ? { scope: "page" } : null,
  ring:        (s, ctx) => ({ tab: ctx.activeTab, tone: ringTone(s.phase) }),
}
```

The **claim reconciler** (reconcile.ts, generalized) diffs desired against actual after every
commit and drives the async appliers (acquire/release), each wrapped in `guardedEffect`
(effect.ts, unchanged) so completion-time revalidation and ceilings are structural. It keeps
per-claim **status**: `idle | pending | active | error | stale` — and *that status is the
missing "neither on nor off" state*, derived and displayable, never stored in a flag. The five
hand-called `sync*` functions become five appliers that nobody calls by hand; a forgotten sync
becomes structurally impossible.

### 3.5 Projections — UI generated from the spec

Because regions, commands, and key hints are data, the surfaces that today drift are *renders*:

- **Command bar**: the spec carries an ordered cap list; each cap = `{ command, hint, litWhen,
  enabledWhen, showWhen, reveals }`. `lit` from a region predicate, `enabled` from gating,
  `reveals` names mode-scoped sub-widgets (the fps slider when `video = "constant"`; the ink-fade
  slider while ink is on) — the "springing sliders" as declared tenancy, which is exactly what
  the overlay's command bar already does informally. Both apps' bars become two spec instances
  of one renderer.
- **Keymap help / cheat sheet**: already generated from `KeyHint`s — unchanged, now fed from the
  same spec object.
- **Ring / indicator**: a claim (it already behaves like one).
- **Trace**: every dispatch appends a mode-change event (mode.ts's own docblock demands this);
  the debug-ui can render mode timelines for free.

### 3.6 The agent bridge — controls become ports of the engine

Regions marked `agent:` auto-register `control()`s whose **setter dispatches a command** and
whose getter reads the region. The engine is the single writer; the control is a *view*. This
structurally kills the `videoOnLive` double-write desync (an agent's `set videoOn true` and the
`v` key now take the identical path), and the agent's control surface, the caps, and the keymap
can no longer disagree.

## 4 · What this is (and is not)

This is a **statechart, subsetted**: parallel regions (orthogonal states), hierarchy (ladders),
guarded event→command bindings, entry/exit effects (claim appliers), and generated UI. We
deliberately drop: history states, nested parallel machines, delayed transitions, actor
spawning. Why not XState, which implements the full thing? Considered and rejected, narrowly:
the value here is not the chart semantics (ours are small) but the **integrations** — `control()`
ports, claims-with-status over `guardedEffect`, `flush()` commit discipline, key-layer input,
command-bar projection, durable persistence, trace events. Those are all bespoke either way;
XState would sit in the middle as a 40 kB opinion about the one part that is easy. If the
reducer ever stops being easy, swapping a statechart library *into* the kernel is a contained
change because the spec is data.

Sizing, honestly: kernel (regions + reducer + esc/blur resolution + dispatch/commit) ≈ 300
lines; claim reconciler with status + guarded appliers ≈ 200; projections (bar model, controls
bridge; help already exists) ≈ 200; Solid adapter ≈ 50. Plus one spec per app (~150 each,
replacing state logic scattered through ~3,000 lines of conductor) and the appliers (mostly
extracted, not written — they exist today as the bodies of `sync*`).

## 5 · The payoff in tests

Everything above the appliers is pure data and pure functions:

- **Table tests**: `(state, command) → state'` rows — the §13.6 ⌘B/Esc/T table becomes an
  executable fixture, one row per cell.
- **Property tests**: Esc from any reachable state terminates at root in ≤ depth steps; no
  reachable state yields two claims on one exclusive resource; every `excludes` invariant holds
  after every command; blur never exits a non-`blurExits` region.
- **Claim tests**: for every reachable state, desired-claims match the table (the reconciler's
  docblock already calls this "the best property test of a modal surface").
- **Divergence as diff**: the overlay spec and the panel spec are two data structures; §13.6's
  divergence ledger becomes a *reviewable structural diff* instead of prose that can rot.

The bug ledger writes the regression suite. The inventory's ledger runs to **~25 named
incidents**, and nearly every one is a table row in this scheme: the F1 family (ring
one-behind, disarm stomped back to armed, ink/selection/video/fps cap inversions, key blip,
zoom restore, reconnect check), the F2 family (caps stale after selection change, "command bar
completely missing"), and the engine-level fixes (stuck `talking` outliving its thread,
send-as-cancel, stranded shot veil, ink drawing in tweak, idle-timeout killing turns during
tweak, ⌘B-as-escape abandoning turns, stale ring lit forever). A handful are genuinely about
async lanes rather than modes (PCM frames chasing a closing socket, ElevenLabs include-list) —
those stay lane tests; the engine doesn't pretend to absorb them.

One more region the migration must claim: **the shared `Engine`'s own flags** (`armed`,
`mode`, `talking`, `threadOpen`). Today the panel dual-writes them beside its own phase
(`main.tsx:957,971,1000`) — two sources of truth for the same fact. Under the engine, they are
either owned regions (with the `Engine` consuming them) or context the reducer reads — never a
second store the conductor must remember to keep aligned.

## 6 · Where it lives, and the migration

Grow it inside `aiui-viz/src/modal/` (per the standing "modal kit first" convention): the kit
keeps its modules; the engine is the new composition layer (`engine.ts`, `claims.ts`,
`bar.ts`). Framework-free core (like the rest of the kit) with a thin Solid adapter. Extract to
its own package later only if a non-viz consumer appears.

Migrate **panel first** (it is the acute patient and its §13.6 tables are already spec-shaped),
one region at a time behind the existing behavior: phase+leader first (the machine), then
ink/video/talk claims, then the bar projection, then delete the five `sync*` functions. The
overlay follows during its planned Solid port — where the payoff is retiring most of
`modality.ts`'s 1,597 lines into a spec plus lane appliers. The §13.6 divergence ledger is the
acceptance test for both.
