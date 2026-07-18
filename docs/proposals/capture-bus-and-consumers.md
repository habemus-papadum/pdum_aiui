# Capture bus + typed consumers (linter turn control, and the road to an oracle)

**Status:** proposal, not yet implemented (owner + agent, 2026-07-18). No code written.
**Spans:** `aiui-intent-client` (sources, routes, UI) and `aiui-claude-channel`
(the live-consumer seam, the sidecar, the vendor engines).
**Reference vendor:** OpenAI realtime (barge-in / turn-detection semantics decided against it;
Gemini Live follows).

This started as a small debugging request — *"let the linter's turn end on an explicit button
instead of at the end of a talk segment, wait for the model to finish, allow barge-in, then go
off."* Working through it surfaced a better frame: that button is not really a linter feature at
all. It is the natural turn model of a **direct conversation** with a real-time model — the
future **oracle** — which the linter can borrow as a debug mode. This document proposes the
architecture that makes both fall out of one design, and calls out the near-term slice worth
building first.

The project's decided-behavior docs (`aiui-intent-client/BEHAVIOR.md`) are **not** treated as
frozen here: this proposal deliberately revises the "Talk" and "The prompt linter" contracts.
Nothing below is built until we agree on it.

---

## 1 · The core split: sources (a bus) vs consumers (routes)

Today capture and consumption are tangled: if audio is running it is *automatically* fed to the
transcriber, and *also* to the linter if the linter is on — with no separable notion of "the
source" apart from "who consumes it." The proposal separates two layers.

**Sources — the capture bus.** *What is being sensed*, controlled by feed buttons:

- **audio** — mode `push-to-talk | hands-free`, with a **source-level mute**.
- **video** — mode `sampled (smart | constant) | manual shot | area`.

**Consumers — routes onto the bus.** *Who is listening*:

- **transcriber** — audio → transcript → builds the prompt (today: always on when audio is on).
- **linter** — audio + video → advisory notes; never touches the prompt (today: the one optional
  route, the `linter` select).
- **oracle** *(future, not built here)* — audio + video → a real-time **conversation** with tool
  calling; never touches the prompt.

```
                       ┌──────────── the capture bus ────────────┐
   [audio src] ──▶     │  audio frames (PCM24k) · talk boundaries │
   ptt/hands-free      │  shots/frames (manual · sampled)         │
   + source MUTE ──▶   │  — consumer-agnostic —                   │
   [video src] ──▶     └───────────────┬──────────────┬──────────┘
   sampled/manual                      │              │
                            ┌──────────┴───┐   ┌──────┴───────┐   ┌───────────────┐
                            │ transcriber  │   │   linter     │   │  oracle (later)│
                            │ → the prompt │   │ → notes only │   │ → conversation │
                            └──────────────┘   └──────────────┘   └───────────────┘
```

The bus is consumer-agnostic; consumers subscribe. That is the decoupling.

---

## 2 · The mute contract (source-level — and already true)

`talk.setMicMuted` already mutes at the **source** — the `AudioCapture` and the PCM worklet
(`aiui-intent-runtime/src/talk-lanes.ts:149`) — so every consumer goes deaf together. We
**formalize and keep** this as an invariant:

> **Mute is a property of the bus, never of a route.** "Muted" (no mic, or the user pressed mute)
> means *nothing in the system is listening*. There is deliberately no "audio to the linter but
> not the transcriber," and no per-consumer mute. A route is either subscribed or not; the source
> is either live or muted.

This is the thing that keeps the UI legible: one mute, one meaning. (The current UI *does* have
mute — the `mute` command / `micMuted` region / `m` key, revealed under hands-free in
`aiui-intent-client/src/caps.ts:76`; it exists only while talking. That stays.)

---

## 3 · The three consumers differ on exactly three axes

The insight that makes the oracle cheap: **linter and oracle are the same machinery** — a live
vendor session (`LiveSession`, `aiui-claude-channel/src/live-session.ts`) fed from the bus. They
differ only in:

| | persona (instructions) | tools | **turn mechanism** |
|---|---|---|---|
| **transcriber** | — (STT, not a live model) | — | segment = **talk-end** |
| **linter** | "overhear a briefing & advise" | `read_file` | **overhear-at-pause** |
| **oracle** *(future)* | "answer me directly" | richer / task tools | **converse, auto-turn-detection by default** |

So there are two live-consumer **turn strategies**:

### overhear (the linter today)

The consumer is a *bystander* to the human↔agent briefing. Its turn ends automatically at each
pause (`talk-end`); it emits a short note; resumes listening; a resume before it fires **merges**
(`aiui-claude-channel/src/linter-sidecar.ts:256-267`); talking over its reply **barges in**
(`cancelActiveResponse`). It never takes the floor.

### converse (the oracle; and the linter's debug mode)

The human addresses the consumer *directly*. The consumer takes the floor, replies (speech +
tools), signals its own turn-complete, and the human can barge in. Two independent knobs:

- **How the human's turn ends:**
  - **automatic turn detection** — the vendor's built-in VAD decides when the human has finished
    and the model should respond. **This is the oracle's default** — it is a real conversation, so
    the natural, low-friction behavior is the same turn-taking every real-time voice assistant
    uses. Concretely, this is the OpenAI realtime `turn_detection` config the linter currently
    pins to `null` (manual) at `aiui-claude-channel/src/openai-live.ts:325`; the oracle flips it to
    `server_vad` (or semantic VAD). It is a supported, first-class API capability, not something
    we build.
  - **explicit button** — the human presses "done" to hand the floor over. This is what the
    original linter-debug request wants. The oracle *may* offer it too (e.g. a "hold the floor"
    mode), but it is not the oracle's default.
- **What happens after the reply:**
  - **loop** — return to listening and keep conversing (the oracle).
  - **auto-off** — one-shot: after the reply completes, the consumer turns off (the linter debug —
    exactly the "then it goes off" the request asked for).

**The payoff:** the button-triggered turn = the **converse** strategy with `turn-end: button` +
`after: auto-off`. If we build converse as a reusable strategy on the live-consumer seam rather
than a linter-specific hack, the oracle later is "the same strategy with `turn-end: auto-VAD` +
`after: loop`, a different persona, and different tools." We build the hard part once.

---

## 4 · Routing rules → really a journey selector

The owner's rules — transcriber is the default; the linter *muxes* on top of it; routing to the
oracle means the linter is *never* on — collapse to a clean exclusive-or:

```
Journey = BRIEF   →  bus → transcriber   (+ linter, optional mux)      [builds a prompt]
Journey = ORACLE  →  bus → oracle          (no transcriber-to-prompt,
                                            no linter)                 [a side conversation]
```

Both journeys share the **same source bus** and the **same source-mute**; only the route set
changes. The constraint "oracle ⊕ linter" becomes structural (you cannot express the illegal
combination) rather than a rule a user has to remember. Whether the UI shows one journey selector,
or a "linter" toggle inside BRIEF plus an exclusive "oracle" toggle, is a later call — but the XOR
is the shape.

(Open sub-question, §8: during the ORACLE journey the transcriber-to-**prompt** is off by
definition, but the oracle may still want *its own* transcription for display. That is the
oracle's internal concern, not a second prompt-building route.)

---

## 5 · What the current code already gives us (and what is welded)

- **Already bus-like — a hardcoded 2-consumer fan-out.** The server hands one audio frame to both
  consumers today: `realtime?.appendAudio()` *and* `sidecar?.onAudioFrame()`
  (`aiui-claude-channel/src/intent-v1.ts:1126-1127`), and talk-start/end fan out the same way
  (`:1178-1188`). Generalizing this to a **route list** is a small step, not a rewrite.
- **Turn-complete is already received.** OpenAI `response.done`
  (`aiui-claude-channel/src/openai-live.ts:255`) carries the response output, so we can tell a
  tool-call turn from a final spoken turn; Gemini's is `serverContent.turnComplete`
  (`gemini-live.ts:315`). Both already fire internally (they flush the reply + bill usage). What is
  missing is only surfacing an `onTurnComplete` callback — the concrete "the model is done"
  signal the request was unsure existed. **It exists.**
- **Barge-in is already a primitive.** `session.cancelActiveResponse()` →
  `response.cancel` for OpenAI (`openai-live.ts:425`); Gemini has no client cancel — its own VAD
  interrupts on new audio → `onInterrupted` (`gemini-live.ts:309`). Works for both; the feel
  differs, hence OpenAI as the reference.
- **`endTurn` already stands alone.** The linter's turn end is a standalone function
  (`linter-sidecar.ts:236`) that today is only *called* from `onTalkEnd`/timeout. The converse
  strategy calls it from a **control** instead.
- **Welded #1 — turn welded to talk-end.** The only trigger for `endTurn` today is `onTalkEnd`
  (`linter-sidecar.ts:279`). Decoupling = drive it from a control chunk, the existing
  reconfiguration path (`intent-v1.ts:1346`), so the STT segment-commit at talk-end
  (`intent-v1.ts:1178`) is never touched. **This is the single most important guardrail against a
  regression.**
- **Welded #2 — the capture encoding is chosen by the consumer.** `talk-lanes.ts` selects
  PCM-stream vs whole-blob from `config().transcriber` (`usesPcmStream`, `:108`). A true bus wants
  one encoding. **PCM24k streaming is the unifier** — the linter and the oracle both consume PCM;
  only the REST/mock transcriber wants a whole segment. That REST path is the one genuine wrinkle
  (§8).
- **Mid-thread route control already works.** Flipping the `linter` select mid-turn sends a
  `control` chunk that starts/stops/swaps the sidecar live
  (`aiui-intent-client/src/lanes.ts:602-617` → `intent-v1.ts:1346`;
  `BEHAVIOR.md` "The prompt linter, reconfigurable mid-turn"). New controls (lint-now, stop,
  later oracle-on) ride the same rail.

---

## 6 · Incremental path (no big-bang)

### Phase 1 — now: the converse strategy, shipped as the linter's debug mode

Build the **converse turn strategy** on the live-consumer machinery and expose it for the linter,
with `turn-end: button` + `after: auto-off`. Deliberately does **not** touch `talk-end`/STT.

- **`live-session.ts`** — add `onTurnComplete?()` to `LiveSessionCallbacks`.
- **`openai-live.ts`** — fire `onTurnComplete` at `response.done` when the output holds no
  `function_call` (`:255-277`). *(Gemini: at `turnComplete`, `:315` — for parity.)*
- **`linter-sidecar.ts`** — factor the turn handling into a **strategy** (`overhear | converse`);
  expose `endTurn()` / `cancelActiveResponse()` as control-driven entry points; on
  `onTurnComplete`, push a new `linter-turn-complete` event.
- **`intent-v1.ts`** — extend `onControlChunk` (`:1346`) to recognize `control:"lint"` with
  `value:"now" | "stop"` → `sidecar.endTurn()` / `sidecar.cancelActiveResponse()`.
- **`aiui-lowering-pipeline/src/types.ts`** — add `linter-turn-complete` to the `IntentEvent`
  union (`:471`); **`engine.ts:82`** — admit it through `ingestLinter`.
- **`linter-pulse.ts`** — handle `linter-turn-complete` (→ `idle` / off).
- **`lanes.ts`** — expose `lintNow()` / `lintStop()`; in the `engine.onEvent` tap (`:522`), on
  `linter-turn-complete` set the `linter` select → `"off"` (the auto-off; the existing
  `disposeLinterControl` effect then closes the sidecar).
- **`panel.tsx`** — a "lint now" + "stop" button pair beside the linter select (where the pulse
  dot already lives, `:507`), enabled off the pulse phase.

Roughly 8 small, mostly-additive files. The linter's overhear behavior stays the default; converse
is the debug override. Useful on its own, and a down-payment on Phase 2 — not throwaway.

### Phase 2 — later: the abstraction, when the oracle is real

- extract **`LiveConsumer`** = `LiveSession` + persona + tools + turn-strategy; the linter and the
  oracle become two instances;
- turn the server's hardcoded fan-out into a **route registry**;
- introduce the **journey selector** (BRIEF ⊕ ORACLE) and the source/route UI split;
- give the oracle `turn-end: auto-VAD` (`turn_detection: server_vad`) + `after: loop`, its persona,
  and its tools;
- unify capture on PCM streaming and resolve the REST wrinkle (§8);
- revise `BEHAVIOR.md` "Talk" + "The prompt linter" into a "Sources, routes, and turns" contract.

---

## 7 · Contract changes this implies (BEHAVIOR.md)

Not frozen — this proposal edits them deliberately:

- **"Talk"** becomes the **audio source** section: modes ptt/hands-free, the source-mute
  invariant, no per-consumer mute.
- **"The prompt linter"** becomes **"routes and turn strategies"**: transcriber (default),
  linter (overhear, optional mux), oracle (converse, auto-turn-detection default), and the
  BRIEF ⊕ ORACLE journey XOR.
- The current "hands-free talk is per-turn; leaving the turn ends it" rule is re-examined once
  listening is a *source* concern rather than a *linter-trigger* concern.

---

## 8 · Decisions to lock before Phase 1

1. **Frame the button-turn as the reusable `converse` strategy** (recommended) — vs a linter-only
   hack. Costs a little structure now; saves the oracle later.
2. **After-reply policy as a flag now:** linter debug = **auto-off** (confirmed by the request);
   oracle = **loop**. Make it a policy parameter, not a hardcode, even though Phase 1 only uses
   auto-off.
3. **Oracle turn default = automatic AI turn detection** (this revision). Confirm the explicit
   button is the *linter debug* default and merely an *option* for the oracle — so Phase 1's
   button and Phase 2's VAD are two settings of one strategy.
4. **REST/mock transcriber on the bus:** standardize on PCM streaming and treat REST as a
   "record-the-window" sink, or leave REST outside the bus story for now? (Bites Phase 2 more than
   Phase 1.)
5. **Video on the bus:** manual shots + sampled frames already reach the linter via `onShot`
   (`linter-sidecar.ts:321`). Confirm the bus carries video identically for all consumers (the
   oracle will want it).
6. **ORACLE-journey transcription:** off entirely, or the oracle keeps its own STT for display
   only (never a prompt)?

---

## 9 · Summary

The debug request and the oracle are the same feature seen from two angles: a live consumer with a
**converse** turn strategy. Build that strategy once — `turn-end ∈ {button, auto-VAD}`,
`after ∈ {auto-off, loop}` — ship it now as the linter's button-driven debug mode (auto-off,
button), and the oracle later is a second instance (loop, auto-VAD) plus a persona and tools. The
capture bus + route split and the source-level mute contract are the surrounding architecture that
keeps it all legible and keeps the transcriber, linter, and oracle from re-tangling.
