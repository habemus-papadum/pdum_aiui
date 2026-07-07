# Proposal B2: modal-kit-first Solid rewrite of the dev overlay

Status: **in progress** — B2.0 (kit), B2.1 (UiMode + reconciler + unified widget, including the
one-project Solid test infrastructure) landed July 2026; B2.2/B2.3 underway. Execution notes and
deviations are recorded at the bottom ([Execution log](#execution-log-july-2026)). Revision of
[solid-rewrite.md](./solid-rewrite.md) (hereafter **B1**), which it supersedes. Companion inputs:
the viz-side design brief `packages/aiui-viz/handoff/modal-interaction-lessons.md` (the bug rules
and the kit sketch this plan makes concrete) and this package's
`handoff/pipeline-and-interaction-model.md` (whose WP2 — `UiMode` + the unified widget — becomes a
milestone of this plan rather than a separate rework).

## What changed from B1

B1 was "port the vanilla surface to Solid, island by island." B2 keeps that migration spine but
changes five things, all in the direction of *pragmatic* dogfooding — the overlay is a floating
dev tool, not a scientific notebook, and it should adopt the viz principles that pay for
themselves here and explicitly skip the ones that don't:

1. **Kit first.** Before any overlay Solid work, the modal-interaction lessons are extracted into
   `@habemus-papadum/aiui-viz` as a reusable **modal interaction kit** (`aiui-viz/modal`), and the
   overlay becomes its first consumer. B1 had no viz-side work at all; B2 makes the extraction the
   point — the overlay rewrite is how we prove the kit is real.
2. **Cells demoted from headline to "where genuine."** B1 planned "async work (transcription,
   correction, lowering previews) as `cell(deps, compute)`." The ground-truth handoff shows that
   work is not deps→value computation — it's server pushes merging into an append-only event
   stream. The stream **is** the reactive core (`state = fold(events)`, the lessons doc's own
   load-bearing idea); Solid signals are the projection layer; cells are reserved for true derived
   async values, of which the overlay may have single digits — possibly zero. That's fine, and
   saying so out loud is what stops force-fitting.
3. **An explicit animation doctrine.** Continuous visuals (audio meter, ink fade, pulse badges)
   are never driven by signal updates — they run on their own clock (CSS first, rAF second,
   interval last) and signals only flip them on/off. B1 was silent here; today's code is
   accidentally right in places and this makes it policy.
4. **No notebook-style `store.ts`/`graph.ts` cell graph.** The overlay's durability contract is
   *full-reload + `engine.replay()` from the turn store* — it must survive arbitrary host-app HMR
   it doesn't control, which is a stronger property than in-repo hot-swap adoption. We adopt
   `durable()` for adopt-on-remount roots and skip the self-accepting graph module entirely.
5. **`modality.ts` decomposition is a named goal.** The 1,700-line closure over ~30 mutable
   locals is where every shell bug has lived. The kit absorbs its mode/keymap/invariant thirds;
   the wire, talk, and capture plumbing extract into focused framework-free modules; the
   `dispatch` switch stays one switch but shrinks to routing.

B1's step 2 (SessionPanel as the first Solid island) has already landed; its constraints section
(shadow-root styling, Solid-aware Vitest project, `vite.ts` stays vanilla) carries over unchanged
and is restated under Risks.

## Part 1 — the kit: `@habemus-papadum/aiui-viz/modal`

A new viz subpath, following the `./plot` / `./site` conventions: entry in both `exports` forms
(dev source string + `publishConfig` conditional object **ending in `default`**), one more
`lib.entry` in `vite.config.ts`, `pnpm test:packaging` after. Pure TS — **no new peers, no Solid
import, no DOM access at module scope** (DOM only inside install functions, engine-style), so the
channel can consume it node-side and the overlay's jsdom suite keeps running unchanged.

Contents, mapped from the lessons doc §4 (numbers are its items):

| # | Lessons item | Kit export (sketch) |
|---|---|---|
| 1 | Mode machine as data | `ModeTable<M, Cmd>`: `{ initial, modes: Record<M, { layer, cursor?, escParent, onEnter?, onExit? }> }` — pure, serializable; mode changes are *the app's events*, the kit never owns state |
| 2 | Keymap layers, exhaustive claims | `KeyLayer<Cmd>` (bindings with per-key `down`/`up`/`repeat` policy + a mandatory layer `fallback: "pass" \| "swallow"`), pure `resolveKey(stack, state, key, phase, repeat) → { command } \| "swallow" \| "pass"`, and `installKeys(getStack, dispatch)` — capture-phase, composedPath-aware typing guard (`isTypingTarget` moves here) |
| 3 | Commands as the only side-effect boundary | Types + convention: keys, clicks, and agent tools dispatch the same `Cmd` union; the kit's dispatch wrapper adds an optional trace hook |
| 4 | Effects report back as events, revalidate on completion | `guardedEffect({ ceilingMs, stillValid }, run)` — ceiling built in, resolves discard when the mode epoch moved; delivery-as-events stays app-side |
| 5 | Reconciler pass | `createReconciler(surfaces)` → `(mode) => void`: named idempotent assertions (veil, cursor, pointer-events, ring) run after **every** event — one missed transition costs a frame, not a wedged UI |
| 6 | Focus as tracked state | `createFocusTracker()` — `last()`, not a DOM query at decision time |

Plus the **diff-flash lift** (lessons §1): `wordDiff` + `DiffRun` move here from
`intent-pipeline/patch.ts`, with `renderRuns` / `runsFragment` / `LiveDiffText` from
`multimodal/diff-flash.ts`. The two couplings break at extraction exactly as prescribed: the
`mm-` class prefix becomes a constructor option (defaulting to today's names) and the house tempo
ships as shared constants (`FLASH_SETTLE_MS = 450/750`), so every aiui surface animates text
change at one tempo in one visual language. `intent-pipeline` re-exports `wordDiff`/`DiffRun` for
compatibility (the channel imports the pipeline; it transitively gains the framework-free
`aiui-viz/modal` — an acceptable edge, see Risks).

Also shipped as *guidance, not code*: the Esc/Enter convention (Esc steps out one level, never
destructive beyond its scope; Enter commits the current scope, never reaches an outer scope's
destructive action) and the mode-ring signaling table from the interaction handoff §B.4 — these
go in the kit's module doc so every viz app inherits the muscle-memory contract.

**Not in the kit:** the event stream, the fold, the engine. Those are app-owned. The kit
disciplines *modes, keys, surfaces, and effects* — the shell layer where all fifteen bugs lived —
and leaves state to the app's own architecture.

**Home: viz subpath, not a new package.** `aiui-util` is Node-only (browser code doesn't belong);
a fresh `aiui-ui-bits` package means reserve/trust/release ceremony for ~600 lines with exactly
two consumers today. A subpath costs one exports entry and can still be promoted to a package
later if non-viz consumers materialize.

## Part 2 — applying it to the overlay

The engine is untouched: append-only `IntentEvent[]`, `composeIntent` fold, verbs in / events
out. What changes is everything around it:

- **The mode table** (interaction handoff §B.4, now expressed as kit data):
  `off / ready / composing / shooting / talking / correcting` (+ `tweaking` when WP4 lands —
  adding a mode becomes adding a row, which is the kit's whole proof). `uiMode()` derives the
  mode from engine state + shell flags as a pure, unit-tested function. The config strip is
  deliberately **not** a mode — it's a pushed *layer* (the K-strip is the canonical layer-not-mode
  case: it claims a few keys, everything else keeps its meaning).
- **The keymap** becomes kit layers: today's `keyCommand` decision table splits into the per-mode
  base layers plus the strip layer, each with explicit `fallback` and per-binding repeat/keyup
  policy (Space's swallow-during-mic-acquisition and unconditional-release rules become
  declarative rows). The existing table tests port over as layer tests and must pass unchanged —
  behavior-identical is the acceptance bar for this step.
- **`renderHud()` splits in two.** Its invariant-enforcement half (stranded-veil guard, cursor,
  pointer routing, share-bounded-by-thread) becomes kit reconciler surfaces, run after every
  event. Its content half (state label, meter on/off, preview visibility) becomes Solid rendering
  off signals. This is the load-bearing simplification: today one function is both the renderer
  and the safety net, which is why it's called from 20 places.
- **Dispatch stays one switch,** but the config strip's DOM-stamp click routing and
  `overlay-tools.ts`'s agent operations already converge on it — the kit contract just names
  what's already true. `overlay-tools.ts` migrates to viz's `agentToolkit` so the overlay's own
  tool surface rides the same machinery it gives apps, and `report()` answers "what mode am I in"
  from `uiMode()` — one answer everywhere.
- **The unified widget** (WP2's "one widget, not two corners"): the HUD pill and the fab/panel
  merge into a single draggable anchor with the mode ring, built as Solid components from the
  start rather than reworking the vanilla HUD only to port it again.

### Signals, cells, and what the stream keeps

One small adapter (`model/engine-signals.ts`) subscribes to the engine and projects the state UI
needs into signals inside a `batch`: `uiMode`, `armed`, `talking`, `threadOpen`, the preview's
`pieces` view-model, toast list, peer list, bus status. Components read signals; nothing but the
adapter subscribes raw. Writes happen in event handlers (no `ownedWrite` gymnastics needed).

Honest cell candidates — each adopted only if it genuinely simplifies the code it replaces:

- **Bus discovery** in `SessionPanel` (today: a 50×100 ms poll for `window.__AIUI__.session`) —
  a cell or plain promise; either kills the poll.
- **Channel health probe** before the session-bus dial — fits `cell` + `CellView` for a
  connection-status affordance.
- Everything else that looks async (transcription deltas, correction round-trips, lowered
  pushes) **stays event-stream**: those are pushes merged into the fold, and wrapping a socket in
  a cell would be dogfood theater. If the count of cells in the finished overlay is zero, the
  rewrite did not fail.

### Animation doctrine (the meter, the lights, the ink)

Rule: **anything that moves continuously is driven by its own clock; signals only turn it on and
off** (one class toggle or `hidden` flip). Never publish a per-frame value (mic level, stroke age)
into a signal. Concretely, per today's inventory:

| Surface | Today | B2 |
|---|---|---|
| Audio level meter | 80 ms interval painting a canvas | Keep as a self-driven island; signal controls mount/on-off only |
| Ink strokes + fade | rAF loop, alpha from stroke age | Keep verbatim; imperative island behind a ref |
| Video "● video" badge pulse | CSS `@keyframes` + `hidden` | Already right — this is the model the others follow |
| REC / mode indication | classList border color | Mode ring class from the reconciler; pulse (talking) is pure CSS |
| Diff flashes | per-event spans + setTimeout settle | Kit `LiveDiffText` / `renderRuns`, house tempo constants |
| Shot rubber-band | per-pointermove style writes | Keep imperative inside the shot island |
| Panel/toast/slide transitions | double-rAF class flip + CSS transition | CSS transitions, class from signal |

The frontend-design guide's imperative-island rule ("never touch signals in the hot loop; bridge
outbound at ~4 Hz *if at all*") is exactly this — the overlay's islands mostly need no outbound
bridge at all.

### Module layout (target)

```
src/
  intent-pipeline/     unchanged; framework-free; re-exports wordDiff from viz/modal
  model/               engine construction, uiMode(), engine-signals adapter, durable roots
                       (engine, turn store — already durable — media-stream owners, shadow host)
  shell/               framework-free plumbing out of modality.ts: wire.ts (outbox/debounce/
                       merge), talk.ts (REST + PCM lanes), capture.ts (shot/video share owners),
                       dispatch.ts (the command switch)
  ui/                  Solid components: Widget (anchor+ring+expander), Panel, Preview, Toasts,
                       ConfigStrip, AdvancedConfig, SessionPanel (exists)
  islands/             ink.ts, meter.ts, shot-veil.ts, drag.ts — imperative, ref-mounted
  vite.ts              untouched (Node, no JSX)
```

Two render targets stay: the fab/panel/toasts live in the shadow root (string styles); the
layers (ink, veil, preview, HUD) stay **light DOM on purpose** — the preview needs native
`Selection` against its text, and the layers sit over the app. Solid renders into both.

## Part 3 — what we deliberately do NOT adopt from the viz doctrine

Stated so nobody "fixes" the omissions later:

- **No notebook page anatomy** — no `SiteHeader`/`TocRail`/`TeX`/plots. The overlay is chrome,
  not a document.
- **No `model/graph.ts` + self-accept HMR dance.** Durability = full-reload + replay (works in
  host apps whose HMR we don't control). `durable()` guards the few adopt-on-remount roots;
  editing overlay source in-repo full-reloads the consumer, and that's the supported contract.
- **No cell-graph-as-architecture.** The event stream is the architecture (it already gives
  traces, replay, and client/server convergence — things a cell graph can't).
- **CellView/data-cell attribution** only where cells actually appear; but the overlay's Solid
  components **do** get `data-source-loc` stamps via the source-locator pass, so the overlay is
  finally inspectable through the same instrumentation it injects into apps (B1's motivation,
  kept).

## Migration plan

Ordered; each milestone lands green (typecheck, Biome, unit + jsdom suites, `test:packaging`
when packaging changes) and behavior-identical unless stated. The adversarial ordering tests
(pointerup-before-keyup fast-drag race, blur-during-hold) are the regression net and must pass
at every step.

| # | What | Where | Size | Notes |
|---|---|---|---|---|
| **B2.0** | **Kit extraction.** `aiui-viz/modal` (mode table, layers, resolveKey/installKeys, reconciler, guardedEffect, focus tracker) + the wordDiff/diff-flash lift with prefix/tempo options. Overlay's `keymap.ts` reimplemented as kit layers behind the same `keyCommand` signature; table tests prove byte-identical decisions. | viz + pipeline | M | Independent of in-flight overlay merges; can start first |
| **B2.1** | **Mode machine + reconciler + unified widget** (absorbs WP2). `uiMode()`, mode table instance, `renderHud` invariants → reconciler surfaces, mode ring, HUD+fab/panel merged into one draggable Solid anchor, `report()` off `uiMode`. Solid-aware Vitest project lands first. | overlay | L | First visible change; jsdom render test + pure-fn tests |
| **B2.2** | **Panel internals to Solid.** Toasts (`<For>` over `errors.ts` state), status line, selection chip, tabs, config strip (decision-free, dispatches commands), advanced-config UI; `engine-signals` adapter; retire `intent.ts` vanilla builders. `overlay-tools.ts` → `agentToolkit`. | overlay | M–L | |
| **B2.3** | **Preview.** Pieces reducer stays pure; keyed `<For>` renders pieces (kills the full `replaceChildren` teardown per event); kit diff-flash; correction editor's textarea + caret/focus stays an imperative island using the kit focus tracker. Light DOM. | overlay | L | Highest risk — do last; shot thumbnails-while-editing and contenteditable stay out of scope (lessons §6) |
| **B2.4** | **Decompose `modality.ts`.** Extract `shell/wire.ts`, `shell/talk.ts`, `shell/capture.ts` around the kit/engine contracts; media owners under `durable()`; `dispatch` shrinks to routing. Target: the god-file dissolves into focused modules, none owning another's state. | overlay | M | Interleaves with B2.1–B2.3 as each third is touched |

**Proof-of-kit follow-up (not in scope, enabled by it):** WP4 tweak mode = one new mode-table row
(pointer released, keymap layer of exactly T + Esc with `fallback: "pass"` — the explicit
handover) + one engine mode value. If that lands in a day, the kit worked.

**Sequencing with in-flight work:** B2.0 touches only viz + `intent-pipeline/patch.ts` and can
start immediately. B2.1+ rewrite `modality.ts`'s neighborhoods — start only after the pending
merges land.

## Constraints & risks

- **Dependency direction.** The overlay gains `@habemus-papadum/aiui-viz` (workspace:^); the
  channel transitively reaches `aiui-viz/modal` through `intent-pipeline`'s wordDiff re-export.
  Acceptable because the subpath is framework-free and realm-free at module scope; the reverse
  edge (viz importing overlay) stays forbidden, as `agent-tools.ts` already models.
- **Packaging.** New viz subpath must appear in dev `exports` *and* `publishConfig` (conditional
  object ending in `default` — the PR #1 lesson), plus the vite `lib.entry`; run
  `pnpm test:packaging`. Source-first dev masks dist-only mistakes here.
- **Vitest split** (carried from B1): `vite-plugin-solid` breaks the pure-Node `.ts` tests, so a
  second Vitest project (jsdom + `solid()` scoped to `.tsx`) is a B2.1 prerequisite.
- **Shadow + light dual targets** (carried from B1): styles stay inside the shadow root for the
  widget; the layers keep an injected `<style>`; no CSS HMR either way.
- **In-place-mutated config.** `applyEffective` mutates the shared `config` object that thunks
  read dynamically; B2.2 must either keep that contract or replumb it as a signal deliberately —
  not by accident.
- **Live-turn safety.** Replay + turn store must keep working at every milestone; the socket,
  media streams, and `getDisplayMedia` grant are owner-scoped singletons that must survive
  component re-renders (hence `durable()` owners, not component state).
- **`vite.ts` stays vanilla** (Node plugin code, no JSX). `intent-pipeline/` stays framework-free
  (it runs in the channel and workers).

## Non-goals

- Rewriting `intent-pipeline/` or the wire protocol; changing the bus, the plugin injection
  contract, or the public API (`mountIntentTool`, `installSessionBus`, `installToolsBridge`).
- Realtime submode work (WP6/RT track), tweak mode itself (WP4 — enabled, not included).
- A contenteditable document view for the correction editor (lessons §6's known residue; budget
  it deliberately, separately).
- Solid-ifying `overlay.ts`'s legacy placeholder panel (retire or leave; not worth porting).

## Open decisions (recommendations inline)

1. **Kit subpath name** — `aiui-viz/modal` (recommended; matches the lessons doc's language) vs
   `aiui-viz/interaction`. Cheap to rename before first release, expensive after.
2. **Does `LiveDiffText` stay framework-free or grow a Solid wrapper?** Recommend: stay
   framework-free (it's used inside imperative islands); a `<DiffText>` component can wrap it
   later if a second Solid consumer appears.
3. **Meter rendering** — keep the canvas island (recommended: zero behavior risk) vs a
   CSS-transform bar driven by the same interval. Decide in B2.4 when `capture.ts` is extracted;
   not a design question, just a cleanup opportunity.

## Execution log (July 2026)

Decisions made while landing the milestones, so the doc stays honest:

- **B2.0 landed as specified** (`aiui-viz/modal`, wordDiff/diff-flash lift with the `mm-*`
  defaults, overlay keymap as three declarative layers behind the byte-identical `keyCommand`).
  One upgrade over the extraction: `isTypingTarget` also matches
  `contenteditable="plaintext-only"` now.
- **B2.1 landed with the widget as an imperative-handle seam** (`ui/widget.tsx`'s
  `WidgetHandle`): the host keeps state in plain values and pushes projections into signals
  created *inside* the render root. Two hard-won Solid-2 facts are now load-bearing test infra:
  (1) signals created outside the render root never propagate; (2) Vitest's node export
  conditions resolved `@solidjs/web` to its **server** build, whose `insert()` is inert —
  components rendered once and never updated. The overlay's vite config now inlines the solid
  packages under test and resolves `browser`/`development` conditions (a sentinel `external`
  regex defeats vite-plugin-solid's forced externalization). Solid component tests run in the
  same project as the vanilla suite (`solid({ include: /\.tsx$/ })` keeps the transform off plain
  `.ts`, whose `import.meta.url` it rewrites).
- **`overlay-tools.ts` stays independent of `agentToolkit`** (B2.2 scope cut, documented in its
  header): the two already share the bridge, the ready event, and the `window.__<ns>` convention;
  the only difference is lifecycle (`dispose()` vs adopt-forever), and wrapping the toolkit to
  add disposal back would fork semantics to share ~30 lines. Dogfood theater — rejected.
- **The HUD slot content stays a small vanilla template** (deliberate residue): five lines of
  innerHTML inside the pill's slot, driven synchronously by renderHud's content half. Solid-izing
  it buys consistency but makes every HUD assertion async for no functional gain; revisit when
  B2.4 extracts `capture.ts` and the meter island gets a formal home.
- **The key-cheat-sheet span retired** into the panel help (§B.4 called it the pill's noisiest
  tenant; the help block already carried the same text).
