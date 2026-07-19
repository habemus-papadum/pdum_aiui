# Capture bus + typed consumers (linter turn control, and the road to an oracle)

**Status:** Phases 1 AND 2 IMPLEMENTED (owner + agent, 2026-07-18).
**Phase 1** — the converse turn strategy as the linter's debug button pair (`lint now` / `stop`;
the `{control:"lint"}` chunk; `onTurnComplete` on the live-session seam; `linter-turn-complete`
+ the client's auto-off).
**Phase 2 (v1 scope, decided with the owner)** — the ORACLE shipped as the second live consumer:
- **oracle = converse + loop**: OpenAI `server_vad` auto-VAD turns, replies loop; the linter's
  overhear machinery untouched.
- **Journey XOR as a config-layer flip**: an `oracle` select (off | openai) beside the linter
  select; turning either on flips the other off (unrepresentable illegal pair), with a
  server-side resolve coercion (oracle wins) and control-handler backstop.
- **Oracle pauses prompt building** (the owner's "like tweak" framing): while on, mic audio
  routes to the oracle alone; talk segments resolve EMPTY (`oracle addressed seg_N` traced);
  send sends the prompt-so-far and the select survives it, so the next turn re-opens the
  conversation. Shots/selections ride both (prompt + oracle) — only the voice switches
  addressee.
- **The §8-6 transcript record sink**: vendor input transcription on (the STT session is
  paused, so nothing double-transcribes) → `oracle-heard` / `oracle-said` record events,
  compiler-skipped, chronicled + traced, 🔮 chips in the preview.
- **Tools**: `read_file` only, through the shared `runConsumerToolCall` runner (the honest
  LiveConsumer extraction: the execution policy is one function; each consumer keeps its own
  event/label vocabulary). A grand single-core abstraction was assessed and deliberately NOT
  built — the overhear machinery is linter-specific and tested; the shared seams
  (LiveSession, session-core, the tool runner) are the real commons.
- **Deferred from v1**: Gemini oracle (flip `automaticActivityDetection` on), richer task
  tools (own follow-on proposal), and a dedicated oracle pulse/status surface.

**Overhear RETIRED (owner, 2026-07-19).** The final simplification: converse is the linter's
ONLY turn strategy. The automatic pause-lints — and with them the transcript wait
(`LINTER_TRANSCRIPT_WAIT_MS`), the timeout, and merge-on-resume, on both sides of the wire —
are deleted; the linter accumulates silently and lints on the button. Two sub-decisions locked:
after-reply is **stay-on** (the select is the only off switch; the Phase-1 auto-off is gone),
and the lint-now/transcript race is **accepted** (the button never waits — a final landing
moments later informs the next lint). This also dissolves the "suppress pause-lints under a
converse mode selector" question from the earlier deferred list: with one mode there is no
selector. §3's overhear description and §6 Phase 1's auto-off are historical record now; the
living contract is BEHAVIOR.md "Sources, routes, and turns".
The decided contract is `aiui-intent-client/BEHAVIOR.md` ("Sources, routes, and turns"); the
persona is published in `docs/guide/oracle.md`.
**§8 decisions locked 2026-07-18** — the six pre-Phase-1 questions are resolved with the owner
(see §8); Phase 1 was built against the anchors below.
**Citations refreshed 2026-07-18** against the current tree — after the S1–S9 "code-smell
sweep" (module splits/consolidations) and the REST-transcription retirement (`ef7f129`). The
architecture and plan are unchanged; `file:line` anchors were re-pinned (two moved to *different
files*, not just new lines) and §5 Welded #2 / §8 #4 now fold in the REST retirement. No feature
code from this proposal has been implemented.
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
(`aiui-intent-runtime/src/talk-lanes.ts:140-144`, `setMuted` on both `audio` and `pcmSource`) —
so every consumer goes deaf together. We
**formalize and keep** this as an invariant:

> **Mute is a property of the bus, never of a route.** "Muted" (no mic, or the user pressed mute)
> means *nothing in the system is listening*. There is deliberately no "audio to the linter but
> not the transcriber," and no per-consumer mute. A route is either subscribed or not; the source
> is either live or muted.

This is the thing that keeps the UI legible: one mute, one meaning. (The current UI *does* have
mute — the `mute` command / `micMuted` region / `m` key, revealed under hands-free in
`aiui-intent-client/src/caps.ts:77-79`; it exists only while talking. That stays.)

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
(`aiui-claude-channel/src/linter-sidecar.ts:267-276`); talking over its reply **barges in**
(`cancelActiveResponse`). It never takes the floor.

### converse (the oracle; and the linter's debug mode)

The human addresses the consumer *directly*. The consumer takes the floor, replies (speech +
tools), signals its own turn-complete, and the human can barge in. Two independent knobs:

- **How the human's turn ends:**
  - **automatic turn detection** — the vendor's built-in VAD decides when the human has finished
    and the model should respond. **This is the oracle's default** — it is a real conversation, so
    the natural, low-friction behavior is the same turn-taking every real-time voice assistant
    uses. Concretely, this is the OpenAI realtime `turn_detection` config the linter currently
    pins to `null` (manual) at `aiui-claude-channel/src/openai-live.ts:291`; the oracle flips it to
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

(Resolved, §8 #6: during the ORACLE journey the transcriber-to-**prompt** is off by definition.
The oracle instead relies on the live model's *own* transcripts — of both the audio it heard and
the audio it spoke — as a record artifact, never a second prompt-building route. The bus should
provide a place to capture those.)

---

## 5 · What the current code already gives us (and what is welded)

- **Already bus-like — a hardcoded 2-consumer fan-out.** The server hands one audio frame to both
  consumers today: `realtime?.appendAudio()` *and* `sidecar?.onAudioFrame()` — since the S3 split
  these live in `aiui-claude-channel/src/intent-stt.ts:297-298` (moved out of `intent-v1.ts`), and
  talk-start/end fan out to the sidecar in `intent-v1.ts:442-444`. Generalizing this to a **route
  list** is a small step, not a rewrite.
- **Turn-complete is already received.** OpenAI `response.done`
  (`aiui-claude-channel/src/openai-live.ts:221`) carries the response output, so we can tell a
  tool-call turn from a final spoken turn; Gemini's is `serverContent.turnComplete`
  (`gemini-live.ts:258`). Both already fire internally (they flush the reply + bill usage). What is
  missing is only surfacing an `onTurnComplete` callback — the concrete "the model is done"
  signal the request was unsure existed. **It exists.**
- **Barge-in is already a primitive.** `session.cancelActiveResponse()` →
  `response.cancel` for OpenAI (`openai-live.ts:372-376`); Gemini has no client cancel — its own
  VAD interrupts on new audio → `onInterrupted` (`gemini-live.ts:256`). Works for both; the feel
  differs, hence OpenAI as the reference.
- **`endTurn` already stands alone.** The linter's turn end is a standalone function
  (`linter-sidecar.ts:247`) that today is only *called* from `onTalkEnd`/timeout. The converse
  strategy calls it from a **control** instead.
- **Welded #1 — turn welded to talk-end.** The only trigger for `endTurn` today is `onTalkEnd`
  (`linter-sidecar.ts:290`, which calls `endTurn` at `:303`/`:329`). Decoupling = drive it from a
  control chunk, the existing reconfiguration path (`intent-v1.ts:514`), so the STT segment-commit
  at talk-end (now `intent-stt.ts:177`, `commitRealtimeSegment` — moved out of `intent-v1.ts` by
  S3) is never touched. **This is the single most important guardrail against a regression.**
- **Welded #2 — capture encoding is chosen by the consumer (but the field has narrowed).**
  `talk-lanes.ts` selects PCM-stream vs whole-blob from `config().transcriber` (`usesPcmStream`,
  `:107`). A true bus wants one encoding — and the tree has **already moved most of the way there.**
  Since the **REST-transcription retirement** (`ef7f129`, 2026-07-18; see the `transcribe.ts` header
  and `intent-v1.test.ts:382`), transcription is **streaming-only**: every channel-side transcriber
  consumes live PCM, and an old `openai` (REST) hello is coerced to the realtime engine at resolve.
  So **PCM24k streaming is already the unifier** for every network consumer — linter, oracle, and
  the surviving STT engines all consume PCM. The *sole* whole-blob case left is the dev-only `mock`
  (`usesPcmStream` = `config.transcriber !== "mock" || submode === "realtime"`), which transcribes
  locally and never uploads. The old "REST is the one genuine wrinkle" is resolved; the residual
  `mock` path stays *outside* the bus and does not shape its encoding (§8 #4).
- **Mid-thread route control already works.** Flipping the `linter` select mid-turn sends a
  `control` chunk that starts/stops/swaps the sidecar live (client side now
  `aiui-intent-client/src/lanes/config-effects.ts:70-88`, `wire.sendControl("linter", …)` →
  server `intent-v1.ts:514` `onControlChunk`; the control vocabulary lives in `frame.ts:96`;
  `BEHAVIOR.md` "The prompt linter, reconfigurable mid-turn"). New controls (lint-now, stop,
  later oracle-on) ride the same rail.

---

## 6 · Incremental path (no big-bang)

### Phase 1 — now: the converse strategy, shipped as the linter's debug mode

Build the **converse turn strategy** on the live-consumer machinery and expose it for the linter,
with `turn-end: button` + `after: auto-off`. Deliberately does **not** touch `talk-end`/STT.

- **`live-session.ts`** — add `onTurnComplete?()` to `LiveSessionCallbacks` (`:93`). *(The S2
  `session-core.ts` consolidated only transport plumbing; the per-vendor turn-complete switches
  stayed in the two engine files below, so these hook points are unchanged.)*
- **`openai-live.ts`** — fire `onTurnComplete` at `response.done` when the output holds no
  `function_call` (`:221`). *(Gemini: at `turnComplete`, `:258` — for parity.)*
- **`linter-sidecar.ts`** — factor the turn handling into a **strategy** (`overhear | converse`);
  expose `endTurn()` (`:247`) / `cancelActiveResponse()` as control-driven entry points; on
  `onTurnComplete`, push a new `linter-turn-complete` event.
- **`intent-v1.ts`** — extend `onControlChunk` (`:514`) to recognize `control:"lint"` with
  `value:"now" | "stop"` → `sidecar.endTurn()` / `sidecar.cancelActiveResponse()`. (Today it
  validates `control === "linter"` against `isLinterVendor`; a new `lint` control adds a sibling
  branch.)
- **`aiui-lowering-pipeline/src/types.ts`** — add `linter-turn-complete` to the `IntentEvent`
  union (`:192`); **`engine.ts:73`** — admit it through `ingestLinter`.
- **`aiui-intent-client/src/linter-pulse.ts`** — handle `linter-turn-complete` (→ `idle` / off).
- **`aiui-intent-client/src/lanes/`** *(was the single `lanes.ts`, split by S3)* — expose
  `lintNow()` / `lintStop()` (`verbs.ts`); in the `engine.onEvent` tap (`lanes/index.ts:178`), on
  `linter-turn-complete` set the `linter` select → `"off"` (the auto-off; the mid-thread linter
  control effect in `lanes/config-effects.ts` then closes the sidecar).
- **`aiui-intent-client/src/ui/`** *(was `panel.tsx`, split by S3)* — a "lint now" + "stop" button
  pair beside the linter select, which now renders with the pulse dot in `ui/config-strip.tsx`
  (see also `ui/pills.tsx`), enabled off the pulse phase.

Roughly 8 small, mostly-additive edit sites (now spread across the split `lanes/` and `ui/` trees).
The linter's overhear behavior stays the default; converse is the debug override. Useful on its
own, and a down-payment on Phase 2 — not throwaway.

### Phase 2 — later: the abstraction, when the oracle is real

- extract **`LiveConsumer`** = `LiveSession` + persona + tools + turn-strategy; the linter and the
  oracle become two instances;
- turn the server's hardcoded fan-out into a **route registry**;
- introduce the **journey selector** (BRIEF ⊕ ORACLE) and the source/route UI split;
- give the oracle `turn-end: auto-VAD` (`turn_detection: server_vad`) + `after: loop`, its persona,
  and its tools;
- capture is already PCM-unified (the REST retirement did this); the only residual is the dev
  `mock`, which stays outside the bus (§8 #4) — nothing left to unify here;
- add a **transcript record sink**: capture each live consumer's model-emitted transcripts — of
  both the audio it heard and the audio it spoke — routed to one or more sinks/processors as a
  record artifact, never a prompt route (§8 #6);
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

## 8 · Decisions — locked 2026-07-18

All six were resolved with the owner. Recorded as decisions, not open questions.

1. **Frame the button-turn as the reusable `converse` strategy — decided: yes.** Build converse on
   the live-consumer seam, not a linter-only hack. Costs a little structure now; saves the oracle
   later.
2. **After-reply policy is a flag, not a hardcode — decided: yes.** `after ∈ {auto-off, loop}` ships
   as a policy parameter. Phase 1 (linter debug) sets `auto-off`; the oracle later sets `loop`. Even
   though Phase 1 only exercises `auto-off`, it is a parameter from day one.
3. **Oracle turn default = automatic AI turn detection — decided: yes.** The explicit button is the
   *linter-debug* default and merely an *option* for the oracle; Phase 1's button and Phase 2's VAD
   are two settings of one strategy (`turn-end ∈ {button, auto-VAD}`).
4. **The dev `mock` transcriber does not touch the bus — decided (owner delegated the call).** The
   mock is a development crutch — never user-visible, never a driver of architecture. It stays a
   special-cased local path *outside* the bus (it never feeds a live consumer) and must not shape
   the PCM-unified encoding. If keeping the residual whole-blob path ever costs anything, the mock is
   expendable — deleting it is preferable to letting a crutch bend the bus. No action now; it is
   simply a non-consideration for the bus design.
5. **Video rides the bus identically for every consumer — decided: yes, confirmed.** Manual shots +
   sampled frames already reach the linter via `onShot` (`linter-sidecar.ts:332`); the bus carries
   video the same way for the oracle.
6. **ORACLE (and linter) transcription bypasses the prompt STT — but the model's own transcripts are
   a first-class bus concern — decided.** The oracle does **not** route through the normal
   transcriber-to-prompt STT. Instead the live model itself emits transcripts, model-dependent, for
   **both directions** — the human's input audio it heard *and* the audio it spoke back — and the
   same already holds for the linter. These transcripts are **not** a prompt-building route; they are
   a record/observability artifact. They are **not critical** to the oracle functioning, but they are
   information we should not silently discard. So the **bus design should provide a place to capture
   and route consumer-emitted transcripts (both directions), possibly to more than one
   sink/processor.** This is a design input for the bus (Phase 2, the transcript record sink), not a
   Phase 1 task.

---

## 9 · Summary

The debug request and the oracle are the same feature seen from two angles: a live consumer with a
**converse** turn strategy. Build that strategy once — `turn-end ∈ {button, auto-VAD}`,
`after ∈ {auto-off, loop}` — ship it now as the linter's button-driven debug mode (auto-off,
button), and the oracle later is a second instance (loop, auto-VAD) plus a persona and tools. The
capture bus + route split and the source-level mute contract are the surrounding architecture that
keeps it all legible and keeps the transcriber, linter, and oracle from re-tangling.

---

## 10 · Implementation report (2026-07-18 → 2026-07-19)

Everything above is now BUILT, through four passes — each decided with the owner, each landing
with tests, typecheck, and lint green across the repo. Where the built thing diverges from the
proposal text above, the divergence was a later owner decision and this section is the record.

**Pass 1 — Phase 1 as proposed.** `onTurnComplete` on the live-session seam (OpenAI
`response.done` sans `function_call`; Gemini `turnComplete`), the `{control:"lint",
value:"now"|"stop"}` chunk, `linter-turn-complete` in the event vocabulary, the button pair in
the config strip. Shipped with the auto-off debug semantics — later superseded (pass 3).

**Pass 2 — Phase 2, v1 scope.** The ORACLE as the second live consumer: OpenAI-only,
`server_vad` auto-VAD, after-reply **loop**, `read_file` via the shared `runConsumerToolCall`
runner (the honest LiveConsumer extraction — one execution policy, per-consumer event/label
vocabularies). The oracle **pauses prompt building** (the owner's "like tweak" framing): mic
audio routes to it alone, talk segments resolve EMPTY (`oracle addressed seg_N`), send sends
the prompt-so-far and the select survives the send. The journeys' XOR is enforced three deep
(client config flip / resolve coercion / control handler). The §8-6 record: vendor input
transcription on → `oracle-heard`/`oracle-said` events, compiler-skipped, chronicled + traced,
🔮 chips. Deferred: Gemini oracle, richer tools, an oracle pulse.

**Pass 3 — overhear retired (owner, 2026-07-19).** Converse is the linter's ONLY mode: it
accumulates silently across talk segments and lints at the `lint now` button. Deleted outright:
`pendingEnd`, the 2.5s transcript wait (`LINTER_TRANSCRIPT_WAIT_MS`, both sides of the wire),
the timeout, merge-on-resume, and `onTalkEnd`. Sub-decisions locked: after-reply is **stay-on**
(the Phase-1 auto-off is gone; the select is the only off switch) and the lint-now/transcript
race is **accepted** (the button never waits; a late final informs the next lint). The persona
was rewritten for on-demand ("You speak ONLY when asked…") and republished verbatim.

**Pass 4 — streaming reply audio (owner, 2026-07-19: "we don't want whole playback anything").**
Whole-clip reply buffering is retired the way REST transcription was: every vendor PCM delta
forwards the moment it arrives, as `seq`-ordered `speech` chunks (`audio/pcm;rate=24000`) under
a per-reply stream id; the client schedules them gaplessly through one Web Audio context
(`SpeechPlayer.feedChunk`), so time-to-first-audio is first-delta, not full-reply-generation.
`speech-cancel` stops a stream. The trace still gets ONE audio blob per reply (server-side
accumulation, playback-independent). TTS acks — genuinely whole little files — keep the clip
path. **Barge-in layering (owner):** the system never second-guesses the model — the ORACLE's
vendor owns barge-in itself (server VAD interrupts; we LISTEN via
`input_audio_buffer.speech_started` → `onInterrupted` → `speech-cancel`), while the LINTER
(manual VAD — the vendor cannot detect it) keeps the explicit client-boundary cancel at
talk-start and `lint stop`.

The living contract is `aiui-intent-client/BEHAVIOR.md` ("Talk — the audio source" and
"Sources, routes, and turns"); the personas are in `docs/guide/prompt-linting.md` and
`docs/guide/oracle.md`. §§1–9 above are the design record; where they describe overhear, the
transcript wait, auto-off, or WAV clips, read them as history.
