# STATUS — browser-extension intent tool, paused 2026-07-13

> Written as a handoff to a debugging/architecture expert. The question on the table:
> **why does this codebase keep producing the same classes of bug, and what refactoring
> would stop it?** This document is the honest accounting: where the work stands, the
> repeated footguns with counts and root causes, and a self-assessment of the code the
> expert is about to read. Companions: [CONTINUITY.md](./CONTINUITY.md) (working
> agreements + trap list), [DEBUGGING.md](./DEBUGGING.md) (what an agent/human can and
> cannot see into), [PHASE-C-PLAN.md](./PHASE-C-PLAN.md) (the plan and its running log),
> proposal §13.6 (`docs/proposals/browser-extension-intent-tool.md` — the interaction
> model and divergence ledger).

## 1 · Where the work stands

All planned phases are **code-complete and committed** (head: `bbd9fff`). Repo gates
green: 1696 tests, lint, `-r typecheck`, `test:packaging`.

| Capability | State |
|---|---|
| §13.6 machine (⌘B idempotent grant/open · esc cancel · d disarm · tweak) | working, live-verified |
| Shots: warm tabCapture stream in the PANEL, JPEG, bytes straight to the wire | verified — 36–48 ms keypress→thumb (M13) |
| Transcript preview / cheat-sheet caps / keymap help — the overlay's real classes | working (shared `./multimodal-ui`) |
| Talk: Space hold / h hands-free / m mute, REST + realtime lanes, REC meter | realtime verified with gpt-realtime-whisper; worklet ships as a file (MV3 CSP) |
| stt picker: scribe-v2 (default) / gpt-realtime-whisper / gpt-4o-transcribe / gpt-4o-mini-transcribe | **mappings unverified live** except realtime-whisper |
| Video sampling: `v` cap, smart (interaction-gated) / constant (1–10 s/frame) | smart-mode gate verified in code only; not yet user-confirmed E2E |
| Ink: page-anchored, permanent by default, vanish toggle + 2–20 s warp fade | working; fade curve is the shared aiui-ink module (C2a) |
| iPad ink (panel = paint host, frames off the warm stream, strokes → tab surface) | **code-complete, never live-verified** (no iPad in the loop yet) |
| Trace pane: dropdown picker w/ pills+summaries, prompt/events cards | working |
| Channel binding: auto-reconnect via storage.local + liveness | working |
| Dev loop: `aiui extension dev` / `reload [--prod]`, dist-dev split, stamps, banner, SW re-injection | working; the single biggest reliability investment of the effort |

Known loose ends: elevenlabs/gpt-4o-transcribe tier mappings are my best reading of
`expandTier` + config fields, untested against a live channel; the iPad path end-to-end;
`c` (clear ink) still gated on ink-mode rather than has-strokes (PHASE-A gap 2); config
strip C8 (agent-settable controls exist; only part of the widget surface does).

## 2 · The repeated footguns — counts, and what they are symptoms of

### F1 · Solid 2.0 write batching → stale same-flow reads (**7+ occurrences**)
phase machine (ring one state behind; a disarm stomped back to armed) · ink cap inverted ·
selection cap stuck lit · key blip · **zoom restore** (set→get same tick read 1×) ·
**channel reconnect check** (`boundPort()` right after `connect()`) · **video/fps caps
inverted**. Each was found *live by the user*, each fixed the same way, and the fix was
only distilled into a primitive (`aiui-viz` **`liveSignal`** — read-your-own-writes) after
the fifth bite. The seventh bite (video caps) happened AFTER the primitive existed,
because the new feature read bare `control()`s in a dispatch path.

**Root cause, honestly:** the panel's core is an **imperative state machine** hand-stitched
to a **reactive store**, and nothing structural forces machine-read state through the safe
primitive. Every new feature re-decides where its state lives, and the default
(`createSignal` / `control`) is the wrong one for dispatch paths.

### F2 · Manual sync discipline for imperative islands (**3+ occurrences**)
The shared UI surfaces (Preview, CheatSheet, KeymapHelp, REC meter) are imperative classes;
building or updating them in owned scopes throws (`REACTIVE_WRITE_IN_OWNED_SCOPE`), so they
are built in a `queueMicrotask` and re-asserted by a hand-called `syncIslands()`. That call
must be remembered at **every** state change — and was forgotten at least three times
(caps stale after selection change; blip line; the "command bar completely missing"
regression came from this family: an initial `hidden = true` no sync path ever cleared).
`syncIslands`/`broadcastRing`/`syncInkPointer`/`syncTabStream`/`syncVideo` are five
parallel obligations with no enforcement.

### F3 · CRXJS/MV3 dev-loop lies (**5 distinct failure modes**, most wall-clock lost)
(a) dev-server restart leaves Chrome running the *previous* entry snapshot, silently;
(b) NEW module files/export-map changes invisible until restart; (c) extension reload
mid-rewrite caches **half an extension** — blank panel, zero errors; (d) a dead dev
server leaves the CRXJS stub polling forever (`readyState: "loading"`, no document — so
even the failure banner can't render); (e) extension reloads **orphan content scripts**
in every open tab (ring/ink/keys silently dead). All five are now mechanized away
(`dist-dev` split + completeness stamp + `aiui extension dev` ordering + CDP re-point +
boot banner + SW re-injection) — but note the shape: *the platform fails silently, and
every silent failure was first misdiagnosed as an application bug.*

### F4 · Type-only imports dragging whole graphs (**3 occurrences**)
Importing a type from `intent.ts` (or `shell/talk.ts` before its fix) pulls the overlay's
full multimodal graph into the extension's TS program, where cross-file interface merging
explodes. Cure each time: leaf modules (`intent-types.ts`). There is no guard against the
fourth occurrence beyond memory.

### F5 · Assumptions that expired when a new consumer arrived (**3 occurrences**)
The channel deliberately did NOT re-fold when a shot's bytes landed ("fin recomputes") —
correct until a human watched the live fold; the trace hero deliberately skipped empty
folds ("turns open empty") — correct until retraction produced a *trailing* empty fold;
`captureVisibleTab`-era capture architecture — correct until latency was felt. These
weren't bugs when written; they were **documented decisions whose comments outlived their
premises**. The panel-as-live-consumer invalidated several overlay-era assumptions.

### F6 · Process self-inflictions (agent workflow, not codebase)
Unasserted `str.replace` patches that silently no-op'd (the storage.local write — its
absence was then misdiagnosed as F1); verification through CDP that was itself testing a
stale artifact (F3 made the *tests* lie); `panel render` fundamentally unverifiable from a
terminal (extension pages never commit in CDP-opened tabs — measured, DEBUGGING.md).

## 3 · Honest assessment of the code you're about to read

- **`src/panel/main.tsx` is the problem file: ~1,300 lines** and still growing. It holds
  the §13.6 machine, the wire composition, talk, video, paint, capture, toasts, islands,
  keyboard dispatch, boot recovery, AND the JSX. It accreted a phase at a time under
  "keep going, commit along the way" momentum. Each subsystem is individually reasonable
  and commented; the *composition* is where the bugs breed.
- **The state machine has no single transition function.** Phase changes happen in
  `enterPhaseTurn`, `leavePhaseTurn`, `disarm`, `leaderDispatch`, and an
  `engine.onEvent` handler — each responsible for remembering the five sync obligations
  (F2). The "derived claims" idea (ink pointer / tab stream / video sampling as pure
  functions of `(phase, tab, flags)`) is right and half-implemented; nothing *runs* the
  derivation automatically when its inputs change.
- **Two reactivity regimes coexist without a boundary.** Solid signals for JSX; plain
  liveSignals for the machine; `control()`s for agent-visible knobs; durable signals for
  persistence — four state kinds, chosen per-site by convention. F1 is the recurring cost
  of that convention being implicit.
- **Test coverage is inverted relative to risk.** The pure layers (leader grammar, fade
  curve, capture helpers, manifest) are well-tested; the **panel brain — where every
  regression actually happened — has zero headless tests.** The bar-hidden regression,
  both cap inversions, and the send-as-cancel bug were all findable by a jsdom test that
  drives `leaderDispatch` and asserts the islands' DOM.
- **The shared-code story is genuinely good** — this is the part to preserve. Engine,
  wire, talk lanes, video sampler, ink surface + fade, preview/caps/help, trace UI are
  all consumed from `aiui-dev-overlay`/`aiui-ink`/`aiui-paint` with zero forks; overlay
  tests (645) never broke. The §13.6 proposal + divergence ledger and the phase logs
  mean intent is recoverable everywhere.
- Docs/comments are dense and mostly truthful, but F5 shows the failure mode: a comment
  that says "deliberately X" keeps X alive after its reason died. Comments record
  decisions; nothing records their *preconditions*.

## 4 · What I'd ask the expert to consider (not prescriptions)

1. **Make the machine real.** One transition function (`dispatch(event): Effect[]` or
   equivalent) owning `phase` + standing flags, with claims derived and effects (ring
   broadcast, island sync, relays) executed from the transition's output — so a forgotten
   sync becomes structurally impossible. The five `sync*` functions are the spec for it.
2. **Kill the state-kind decision.** A rule (or wrapper) such that *all* machine-read
   state is `liveSignal`-backed by construction — e.g. a `machineStore()` that wraps
   controls/durables and exposes only read-your-writes accessors. F1 dies when the wrong
   default becomes unwritable, not when people remember the right one.
3. **A panel-brain test harness.** jsdom + the real engine + fake chrome.* (the relay and
   tabs APIs are thin) driving `leaderDispatch`/phase transitions and asserting caps,
   ring broadcasts, and claim relays. Every F1/F2 regression above becomes a table row.
4. **Split main.tsx** along the seams that already exist in prose: machine / media
   (capture+talk+video+paint) / wiring (wire+session) / view. The modules already have
   names in the comments.
5. **Leaf-type convention** (F4): types consumed across package-ish boundaries live in
   dependency-free leaf modules, enforced by a lint or a packaging test, not by memory.
6. Consider whether **comments recording decisions should name their premises** (F5) —
   "deliberately no recompose *because nobody reads the live fold*" would have been
   self-invalidating the day the panel shipped a live fold reader.

## 5 · Fast orientation for the reader

- Run it: `aiui extension dev` from the repo root (starts Vite, re-points the session
  browser, verifies); reopen the side panel by hand (only a user gesture can). Production
  escape hatch: `pnpm -C packages/aiui-extension build` + `aiui extension reload --prod`.
- The measured platform truths (stream-id consumption in the panel, invocation gate,
  CSP/worklet, capture latencies) are in `archive/extension-spikes/RESULTS.md` M1–M13.
- File map: `src/panel/main.tsx` (the brain, see §3) · `panel/leader.ts` (key grammar,
  pure, tested) · `panel/capture.ts` (warm stream) · `panel/paint.ts` (iPad host) ·
  `panel/session.ts` (binding) · `src/content.ts` (page surface: ring/ink/keys/selection)
  · `src/sw.ts` (broker: stream ids, ⌘B, re-injection) · shared code enters via
  `aiui-dev-overlay` subpaths (`/intent-pipeline`, `/wire`, `/multimodal-ui`,
  `/multimodal-talk`, `/multimodal-video`) and `aiui-ink`.
