# Handoff: streaming-friendly turns (incremental lowering + realtime STT/TTS)

> **STATUS — DESIGN / plan of record (2026-07-05). Not implemented.** This is the next stage of
> the multimodal intent system that graduated in `multimodal-intent-graduation.md` (P0–P6 landed):
> it promotes the L1/L2 rungs sketched in `workbench/docs/openai-audio-stack.md` from "spike later"
> to a concrete build, and adds the incremental-lowering work that makes today's REST path itself
> feel quicker. It **extends** the audio-stack ladder, it does not contradict it — L0 REST stays the
> default and the fallback; L1 realtime and L2 audio-back become selectable modes behind the same
> `Transcriber` seam and the same `intent-v1` wire. Nothing here is built yet; every phase below
> names its files and seams so it can be picked up cold. From the aiui-main session.

## The goal, in one paragraph

Today a turn is silent on the wire until you stop talking: the modality records a whole segment
(`MediaRecorder`, talk-start → talk-end), uploads it, and the channel transcribes it REST-style —
a **~1–1.5 s floor per segment** before the preview stops lying about liveness, and a **~2 s** LLM
round trip when a correction lands. This doc makes the turn *streaming-friendly* on two fronts.
First, **incremental lowering**: as events arrive (a transcript, a correction, a screenshot), the
channel does the cheap, pure, or pre-warmable work *then*, so `fin` is a near-empty commit rather
than the whole lowering. Second, **realtime STT (L1)**: the client streams audio *chunks* while you
talk into a per-thread OpenAI realtime transcription session the channel holds, and partial-text
deltas echo back over the `transcript-delta` path that already exists — the preview fills as you
speak. On top of that, **audio-back acks (L2)**: short spoken confirmations ("got it", "sent") the
channel synthesizes and pushes to the page, eyes-free. The whole thing has to be *testable* without
a human at a mic wherever possible — that's the section the user flagged as hard, and it gets a real
answer: streaming fixtures for units, a `say`-fed realtime bench for latency, a capped-key micro-e2e
for the live wire, and a short scripted dogfood for the felt qualities only a human can judge.

## What exists today (the streaming primitives are already here)

The graduation left the wire *almost* ready for this — the key realization is that the
`transcript-delta` echo path and the server→client push channel already exist and are already
exercised by the mock:

| Primitive | Where | State for streaming |
| --- | --- | --- |
| `transcript-delta` event | `intent-pipeline/types.ts:38`, engine `transcriptDelta` | **exists**; `mergeLowered` in `modality.ts:330` already renders deltas into the preview |
| server→client push | `LoweredMessage` (`intent-v1.ts:56`), `ctx.push`, `web.ts:165` `socket.send(JSON.stringify)` | **exists**; JSON text only (no binary back-channel yet) |
| per-segment transcription on arrival | `onAttachmentChunk` seg branch (`intent-v1.ts:308`) | **exists** but whole-blob: one `seg_N` frame = one finished segment |
| pre-warmed LLM call | `resolveCorrection` runs the diff on the patchless-correction frame's arrival (`intent-v1.ts:255`) | **exists** — the precedent for "do fin-work early" |
| condition/polish slots | `silenceTrim` / `imageDownscale` gated stubs (`intent-v1.ts:132`) | **exists** as identity passes; structure only |
| `chunk` envelope tag | `ChunkDescriptor` (`frame.ts:89`), additive by design | **the extension point** for streamed audio frames |
| capture | `AudioCapture` = one `getUserMedia` + one `MediaRecorder` per segment (`multimodal/audio.ts`) | webm/opus, whole-segment; **needs a PCM path for realtime** |

What is *missing* is exactly three things: a way to carry audio as a *stream* of frames rather than
one blob (an additive `chunk` kind), a processor that holds one upstream realtime session per thread
(and a hook to tear it down when a turn is abandoned), and a client PCM capture path. Everything
downstream of a `transcript-delta` echo is done.

## 1 · Latency model of today's pipeline

Where the wall-clock goes for one spoken segment, from the moment you release Space to the moment
the preview reads right, measured in the lab (`bench/transcribe-bench.ts`, synthesized speech, 2026-07):

| Stage | When it runs today | Cost | Streaming-friendly? |
| --- | --- | --- | --- |
| record segment | talk-start → talk-end | = talk duration | inherent |
| `MediaRecorder.stop()` flush | talk-end | tens of ms | fine |
| upload `seg_N` (loopback) | after stop | ms | fine |
| **REST transcription** | on `seg_N` arrival | **~1.0–1.5 s floor** (4o family, barely grows with length; `whisper-1` scales) | **no — this is T6** |
| condition passes | on arrival | ~0 (stubs) | already incremental |
| correction diff (if any) | on the patchless-correction frame | **~2.1–2.3 s** (`gpt-4o-mini`, temp 0) | already pre-warmed on arrival |
| blob save + shot-path wiring | **at `fin`** | disk I/O × attachments | **movable earlier** |
| `composeIntent` | **at `fin`** | sub-ms (pure) | **movable / speculative** |
| `augmentTextPrompt` + `sendPrompt` | **at `fin`** | ms | must stay at fin (observable) |

Read: the two dollars-and-seconds stages (STT, correction) **already run on arrival**, not at `fin`
— the graduation got that right. The floor that hurts is REST STT's ~1.4 s of dead air *after you
stop*, which section 3 attacks by streaming. The fin-time work that remains (blob save, compose,
augment) is cheap; section 2 moves the movable parts earlier anyway, because once STT is streaming
the compose/augment tail becomes the visible latency and every avoidable millisecond at `fin` is a
millisecond of felt lag before the agent sees the prompt.

## 2 · Incremental lowering (make `fin` a near-empty commit)

The principle, borrowing the audio-stack cost frame: **anything cheap, pure, or pre-warmable runs as
events arrive; `fin` only commits the one observable side effect** (the notification into the running
Claude session). The seams are all in `intent-v1.ts`.

**Speculative compose (cheap, pure).** `composeIntent(events, policy)` is a pure fold over the event
stream with no side effects. Run it at the end of `onEventsChunk` and after every echo/correction
merge, caching `lastComposed`; `fin` uses the cached result (or re-runs once — it is sub-ms). This
buys nothing on its own but is the enabler for the two below, which need a live composed view.
*Seam:* a `recompose()` call at the tail of `onEventsChunk`, `resolveCorrection`, and the seg-branch
of `onAttachmentChunk`.

**Blob save + shot-path wiring on arrival (removes fin-time I/O).** Today `lower()` loops every
attachment and `trace.recordBlob`s it at `fin`. Move each `recordBlob` into `onAttachmentChunk`: a
`shot_N` is saved the moment its bytes land, and because attachments flush their correlated event
first (`modality.ts:254`), the matching `shot` event is already in `events` — so its `path` can be
wired immediately instead of in the fin remap. `fin` then does zero disk I/O.
*Seam:* fold the `lower()` attachment loop (`intent-v1.ts:347`) into `onAttachmentChunk`; keep the
`shotPaths` map maintained incrementally.

**Polish on arrival (cheap).** The `polish` slot (filler-strip, number/unit normalization) should
run on each `transcript-final` as it lands, not on the whole transcript at `fin` — same slot
structure as `condition`, just moved to the per-segment seam.

**Pre-warm the prompt skeleton.** `augmentTextPrompt(body, hello, selection)` builds a tab/source
preamble that is fully known at `hello` time (only the body and the late `selection` are dynamic).
Assemble the static preamble once at processor construction so `fin` only concatenates.

**Pre-warm LLM calls — what beyond the correction diff?** The correction diff already runs on
arrival (the precedent). The other pre-warmable spend: **image downscale** on a `shot_N`'s arrival
(the `imageDownscale` slot, made real, runs while you keep talking rather than blocking `fin`); and,
once L1 lands, the realtime session's `session.update` **at thread-open** so the WS handshake and
config overlap the arm→talk gap (section 3).

**What must NOT be speculative** — the invariant that keeps this safe: nothing the user or agent can
*observe* may happen before `fin`. Concretely, never call `ctx.sendPrompt` early (it injects into the
live session — irreversible and visible), never `ctx.close()` early, never push a user-visible `note`
speculatively, and **bound paid speculation** — the correction diff runs once on the settled
patchless request, never per partial delta. Speculation only ever *populates caches and the trace*;
`fin` (and only `fin`, and only when not cancelled) commits the notification.

Net effect: with streaming STT feeding partials and the above moving the tail off `fin`, the felt
latency of "I stopped talking → the agent has my prompt" collapses toward the realtime session's
final-transcript time plus a couple of pure-function milliseconds.

## 3 · Realtime STT (L1): the streaming transcriber

The `Transcriber` seam (`channel/transcribe.ts`) grows a **third** implementation beside `mock` and
`openai` (REST): `openaiRealtimeTranscriber`. REST stays the default and the fallback; realtime is
selected by config (below).

### Verified OpenAI surface (developers.openai.com, read July 2026 — ⚠ re-verify before code relies)

> **Re-verified live 2026-07-05 (S2). Drift found: the Beta shape below is disabled.** The endpoint
> now rejects `OpenAI-Beta: realtime=v1` / `transcription_session.update` with
> `beta_api_shape_disabled` ("use /v1/realtime for the GA API"). The GA shape S2 ships:
> `wss://api.openai.com/v1/realtime?intent=transcription`, **`Authorization` header only**, and one
> `session.update` with a **nested** `session: { type: "transcription", audio: { input: { format:
> { type:"audio/pcm", rate:24000 }, transcription: { model, delay? }, turn_detection: null } } }`.
> Ready signal `session.updated`. Everything else in this section (append/commit, delta/completed,
> `gpt-realtime-whisper`, the `delay` levels) verified real. See `channel/realtime.ts` for the
> canonical record.

- **Model:** `gpt-realtime-whisper` — "natively streaming, designed for realtime sessions," with a
  tunable `audio.input.transcription.delay` (`minimal` | `low` | `medium` | `high` | `xhigh`) that
  trades latency for accuracy. (`gpt-4o-transcribe` / `gpt-4o-mini-transcribe` can also run in a
  transcription session and *do* support turn detection; `whisper-1` is legacy, not natively
  streaming.) Note the audio-stack doc's placeholder name `gpt-realtime-whisper` turned out to be
  the *real* id; its L2/L3 names (`gpt-audio-1.5`, `gpt-realtime-2`) are forward-dated — the current
  real ids are `gpt-realtime` (speech-to-speech) and `gpt-4o-mini-tts` (REST TTS), used in section 4.
- **Session:** a WebSocket connection with a `session.update` of `"type": "transcription"`; OpenAI
  explicitly recommends **WebSocket for server-side audio pipelines** and WebRTC for direct browser
  media. Our audio originates in the browser but is relayed through the channel — so the channel
  holds the **WebSocket**, which is the recommended shape for a relay.
- **Audio input:** `input_audio_buffer.append` with **base64 PCM16**, `audio.input.format` =
  `{ type: "audio/pcm", rate: 24000 }` (24 kHz mono ⚠ confirm rate options). Manual
  `input_audio_buffer.commit` ends a segment when turn detection is disabled.
- **Events back:** `conversation.item.input_audio_transcription.delta` (partial `delta`) and
  `.completed` (final `transcript`), each with an `item_id`; plus `input_audio_buffer.committed` /
  `speech_started` / `speech_stopped`.
- **Turn detection:** `session.audio.input.turn_detection` = `server_vad` (silence chunking) or
  `semantic_vad` (`eagerness`: low/medium/high/auto). In transcription sessions VAD only controls
  *chunking*. For `gpt-realtime-whisper`, OpenAI says omit turn detection / set `null` and commit
  manually — which fits PTT exactly.

### Client capture: AudioWorklet PCM, not MediaRecorder timeslice

`MediaRecorder` with a `timeslice` emits **webm/opus fragments**, and only the first fragment carries
the container header — mid-stream fragments are not independently decodable, so they cannot be fed to
a realtime PCM buffer without server-side container reassembly. The realtime API wants raw PCM16
anyway. So the realtime path uses an **`AudioWorklet`**: it yields `Float32` frames at the
`AudioContext` rate (typically 48 kHz), which we downsample to the session rate and convert to
Int16LE. The uncompressed PCM cost (~48 KB/s at 24 kHz mono) is irrelevant over loopback (client →
channel is localhost), and the channel → OpenAI hop wants PCM regardless, so no codec is saved by
keeping opus. `AudioCapture` keeps its `MediaRecorder` path for the REST fallback and grows a
parallel `pcmStream(onFrame)` for realtime — two capture modes behind one class.
*Seam:* `multimodal/audio.ts` gains the worklet path; `modality.ts:478` `talkStart` branches on the
transcriber choice (as it already branches for `needsAudio`).

### Wire: an additive `audio` chunk kind

A streamed segment arrives as many frames, unlike a whole-blob `attachment`. Rather than overload
`attachment` (which every shot and the REST-audio path rely on being one-frame-one-blob), add a
sibling `ChunkDescriptor` member — additive, so `PROTOCOL_VERSION` is unaffected exactly as `chunk`
was designed to be:

```ts
type ChunkDescriptor =
  | { kind: "events" }
  | { kind: "context" }
  | { kind: "attachment"; id: string; mime: string }        // whole blob — shots, REST audio (unchanged)
  | { kind: "audio"; id: string; seq: number; mime: string }; // one streamed PCM frame of seg_N
```

The **segment boundary reuses the events already on the wire**: `talk-start` opens `seg_N`, the
`audio` frames carry its PCM in `seq` order, and the existing `talk-end` event commits it
(`input_audio_buffer.commit`) — no `last` flag needed, and it honors the audio-stack Q1 position that
the *gesture* (PTT) stays the human-facing contract. One caveat: the modality batches events on a
60 ms debounce, so `talk-end` must be **flushed immediately** at end-of-talk (the modality already
flushes the outbox before an attachment; do the same before commit) or the commit lags a frame.
*Seam:* `frame.ts` (channel) + `protocol.ts` (overlay) gain the member in lockstep; the protocol doc's
`intent-v1` table gains a row.

### Processor: one realtime session per thread

`intentProcessor` opens **one** upstream realtime WS per thread when `transcriber === "openai-realtime"`,
lazily but eagerly — at **thread-open**, so the handshake + `session.update` overlap the arm→talk gap
rather than adding to first-segment latency. Each `audio` frame → base64 → `input_audio_buffer.append`;
`talk-end` → `commit`. Incoming `…transcription.delta` → a `transcript-delta` event pushed via the
existing `LoweredMessage`; `.completed` → a `transcript-final`. **This is the reuse that makes L1
cheap: the client's `mergeLowered` already renders both** (`modality.ts:330`), and the mock already
proves the delta path. On `fin`/`cancel`/connection-drop the WS is closed.

Session lifetime: **per-thread** (matches the processor lifecycle and isolates turns) is the
recommendation; a per-connection warm session reused across turns is a latency optimization to
consider later if handshake cost shows up in the bench.

### Config selector: an enum value, not a boolean

Add `"openai-realtime"` to the `transcriber` enum rather than a separate `streaming: boolean`:
streaming is not orthogonal to *which* implementation runs (it is a different vendor endpoint, model,
input format, and session lifecycle), so it belongs as a third value on the one seam-selector the
lowering already reads (`resolveIntent`, `intent-v1.ts:88`). `correctionModel`-style companion knobs
(`realtimeDelay`, `realtimeModel`) ride the same loosely-typed `intent` hello. The default stays
`openai` (REST); realtime is opt-in per the config design.

## 4 · Audio-back acks (L2): short spoken confirmations

Scope, deliberately narrow (the audio-stack L2 position): **acks and one-liners, not conversation** —
"got it," "screenshot captured," "sent." Text remains the single source of truth for the agent; audio
is a courtesy channel for the human's ears so they can keep looking at the app.

**Where TTS runs — the channel, REST.** `POST /v1/audio/speech` with `gpt-4o-mini-tts` (verified:
chunked-transfer streaming, formats mp3/opus/aac/flac/wav/pcm, steerable, 11 voices) is a plain POST
that returns audio bytes — the channel already makes REST calls with the same key, so this is the
minimal addition. Prefer it over realtime speech-to-speech audio-out for acks: no session to hold, no
per-minute billing, and a one-sentence ack is a few KB.
*Seam:* a new `channel/speak.ts` seam mirroring `transcribe.ts` (mock + openai), with the transcript
of the spoken text logged to the trace so the IR records what the human was told.

**How audio reaches the page — base64 in a JSON `speech` message.** Server→client is JSON text today
(`web.ts:165`); the client dispatches server messages by `kind` (`protocol.ts`, `onServerMessage`).
Add an additive kind — no protocol change:

```jsonc
{ "kind": "speech", "threadId": "…", "mime": "audio/mp3", "audioBase64": "…" }
```

Recommend this over a binary server→client frame: acks are small, base64 inflation is negligible, and
it keeps the ack path purely additive (a new `kind` the way `lowered` was). If acks ever grow to
streamed sentences, promote the *back*-channel to binary frames then — noted, not built.

**How it plays — the modality.** `handleServerMessage` gains a `speech` branch → decode base64 → play
via a small player (`new Audio(objectURL)` or a shared `AudioContext`); the modality already owns page
audio (`AudioCapture`).

**Barge-in.** On `talk-start` the modality stops/ducks any playing ack (it already knows `talk-start`
— `dispatch` → `talkStart`). Rely on `getUserMedia`'s default echo cancellation so a playing ack
doesn't bleed into the mic; keep acks short to shrink the collision window. This is the open UX
question the audio-stack flagged — cheap to feel once wired, impossible to settle on paper.

**Turn detection's role.** With PTT, an ack triggers on `talk-end`/segment-final. Once L1's server/
semantic VAD becomes the boundary (section 5, later), "user stopped speaking" is the natural,
model-supplied trigger point.

**What triggers an ack — two designs, recommend the first.** (a) **Lowering milestones**: the channel
speaks deterministic, no-LLM strings at known points ("sent" on a successful `fin`, behind a config
flag) — cheap, testable, ships first. (b) **Agent-driven speech**: the running Claude session decides
to speak back via a channel API (a `POST /speak`, or an MCP tool that routes to the page's speaker) —
richer, but needs the agent to choose to use it and a server→page→speaker route. Ship (a) as one
spoken "sent ✓" on fin; leave (b) as the follow-up once the route exists.

## 5 · Testing strategy (the hard part, answered in four tiers)

The user's worry is right — streaming and felt latency resist ordinary unit tests. Split the surface
by *what can be asserted without a human*:

**Unit — streaming fixtures (the bulk).** Today's fixtures are captured event streams replayed
through `composeIntent` (`intent-pipeline/fixtures.test.ts`). Extend the format to **ordered wire
sequences**: interleaved `events` / `audio` frames and server echoes, including a
delta→delta→final progression. Drive the processor with a **scripted mock realtime session** (a
delta emitter, the streaming sibling of `mockTranscriber`). Assert: (1) the merged stream is correct;
(2) the **final composed intent equals the REST path's** — partial deltas are noise that must not
change the committed prompt; (3) the new `audio` chunk round-trips through `frame.ts`; (4) an
abandoned turn (frames, no `fin`) closes the mock session (the teardown hook, section 7). All offline,
deterministic, no key.

**Lab bench — `say`-fed real realtime session (the latency answer, T6).** Extend
`bench/transcribe-bench.ts`: the same `say`-synthesized references, but streamed through a **real**
`gpt-realtime-whisper` session (open WS, feed PCM in wall-clock order, collect the delta timeline).
Report the numbers REST cannot give: **time-to-first-partial** (felt liveness), **time-to-final-after-
speech-end** (the number that competes head-to-head with REST's ~1.4 s floor), final WER, and $/min.
`corpus-run.ts`'s matrix gains a tier axis (L0 REST × L1 realtime × `delay` setting). Output latency
histograms REST vs realtime — this is what decides whether L1 graduates from spike to default.

**Micro-e2e — the capped-key live smoke (mirror `openai-pipeline.e2e.ts`).** One short realtime
session: convert the checked-in `test/fixtures/segment.wav` to PCM16 24 kHz, stream it, assert **shape
only** — at least one `delta` arrives, one `completed` with non-empty `transcript`, clean close. Plus
a TTS smoke: `POST /v1/audio/speech` one short string, assert 200 + non-empty audio + content-type.
Both `*.e2e.ts` (so `pnpm test` skips them), `describe.skipIf(!OPENAI_API_KEY)`, near-zero tokens,
run by the weekly `openai-e2e.yml` on the dedicated hard-capped project key. Fractions of a cent.

**Human with a mic — the dogfood script (the irreducible remainder).** Only a person can judge felt
latency and barge-in feel. Keep it to a fast, repeatable checklist run behind the config toggles:

1. **Liveness** — arm, dictate a sentence; partials should appear *while you speak*. Toggle
   `transcriber: openai` vs `openai-realtime` back-to-back — the difference should be obvious.
2. **Felt final latency** — how long after you stop does the preview read right? (Compare to the
   ~1.4 s REST floor; realtime should feel near-instant.)
3. **Correction feel** — select a word, speak the fix; is the ~2 s round trip acceptable mid-flow?
4. **Spoken ack** — does a spoken "sent" beat the visual toast for a heads-up confirmation?
5. **Barge-in** — start talking while an ack plays; does it duck/stop cleanly, any echo into the mic?
6. **VAD feel (only after section 5's follow-up)** — server vs semantic VAD as the boundary when PTT
   is dropped; does semantic `eagerness` chunk where you'd expect?

Each item has a one-line "good looks like" so the run is minutes, not a session.

## 6 · Phasing (each lands independently)

**S1 — incremental lowering. → landed 2026-07-05.** Pure refactor of `intent-v1.ts` (section 2):
speculative compose, blob-save + shot-path wiring on arrival, polish-on-arrival, pre-warmed preamble.
**No wire change, no new deps, fixtures unchanged** (final output is identical). Lands first — it
de-risks the tail and is the cheapest felt win even on the REST path. *Files:* `intent-v1.ts` (+ its
tests). Also landed the S2 dependency the doc flagged (the `StreamProcessor.onClose` teardown hook,
`channel.ts` + `web.ts`, section 7) early, since it is additive and abandoned turns should drop their
speculative state through it. *Files:* `intent-v1.ts`, `prompt-context.ts`, `channel.ts`, `web.ts`,
`tracing.ts` (+ tests), `docs/websocket-protocol.md`.

**S2 — the realtime transcriber spike. → landed 2026-07-05.** The `audio` chunk kind
(`frame.ts` + `protocol.ts` + protocol doc), the per-thread realtime session in a new
`channel/realtime.ts` (`openRealtimeSession`, not the `Transcriber`-shaped `openaiRealtimeTranscriber`
the doc sketched — a streaming session is a different shape than one-blob-in/text-out) wired into
`intent-v1.ts`, the AudioWorklet PCM path (`multimodal/audio.ts`'s `WorkletPcmSource` behind a
`PcmSource` seam), the streaming branch in `modality.ts`, and the `"openai-realtime"` config value
(+ `realtimeModel`/`realtimeDelay`). The `StreamProcessor.onClose` teardown had already landed in S1;
S2 uses it to close the upstream socket. REST stays default + fallback. **Drift from this doc's §3,
found by re-verifying live:** the **Beta** shape (`OpenAI-Beta: realtime=v1`,
`transcription_session.update`) is now disabled (`beta_api_shape_disabled`); the channel speaks the
**GA** shape — `wss://api.openai.com/v1/realtime?intent=transcription`, `Authorization` header only,
one `session.update` with a nested `session.type: "transcription"`. Everything else (PCM16/24k,
`turn_detection: null`, `input_audio_buffer.append`/`.commit`, `…delta`/`…completed`,
`gpt-realtime-whisper`, the `delay` knob) verified real.

**S3 — realtime bench + e2e tier. → landed 2026-07-05.** The `say`-fed realtime leg in
`bench/transcribe-bench.ts` (release→final + partials-before-release, side by side with REST), the
micro-e2e realtime smoke (`packages/aiui/test/openai-realtime.e2e.ts`, wired into `openai-e2e.yml`),
and the streaming unit fixtures (`fixtures/streaming/realtime-turn.json` + the channel's
`realtime.test.ts`). The TTS smoke and `corpus-run.ts` tier axis are deferred with S4 (audio-back)
and the corpus runner respectively. *Files:* `bench/`, `test/*.e2e.ts`, fixtures.

> **T6 answered (measured live 2026-07-05, `gpt-realtime-whisper`, `say` utterances).** Realtime's
> **release→final** is **~2.2× faster** than REST — median **655 ms vs 1427 ms** (per-utterance:
> 655/614/692 ms realtime vs 1427/909/1183 ms REST across 1.9–21 s clips). **But** this model emits
> **0 partials before release** — with manual commit it transcribes the *committed* buffer, so there
> is no live-preview-while-talking from whisper; the win is purely the faster final. Streaming
> partials *during* speech would need a model that emits interim results (e.g. `gpt-4o-transcribe`
> with VAD) — a follow-up the bench's `--realtime=` list can measure. So L1 graduates on **latency**
> (a clear win), not yet on **liveness**.

**S4 — audio-back acks.** `channel/speak.ts`, the base64 `speech` server message, the modality player
+ `talk-start` duck, one milestone "sent" ack behind a config flag (section 4). Additive server
message kind; no wire break. *Files:* `channel/speak.ts`, `intent-v1.ts`, `modality.ts`, config.

**S5 — turn detection off PTT (follow-up, gated on S2 dogfooding).** Server/semantic VAD as the
segment boundary *under* the PTT gesture — only pursued if the dogfood says PTT is the bottleneck.
Keep the gesture as the contract.

Order: S1 (pure, immediate) → S2 (the spike) → S3 (measures it) → S4 (independent UX) → S5 (gated).

## 7 · Open decisions (with recommendations)

1. **Realtime capture format** — AudioWorklet PCM16 (**recommend**, section 3) vs MediaRecorder
   timeslice. PCM avoids server-side container reassembly and matches the API's native input.
2. **Config knob** — `transcriber: "openai-realtime"` enum value (**recommend**) vs a separate
   `streaming: boolean`. Streaming isn't orthogonal to the implementation; keep one selector.
3. **Session lifetime** — per-thread, opened at thread-open (**recommend**) vs a per-connection warm
   pool (later optimization if handshake cost shows in the bench).
4. **Segment-commit signal** — reuse the existing `talk-end` event (**recommend**; keeps PTT the
   contract) vs a `last` flag on the `audio` chunk. If the 60 ms event-debounce race proves annoying,
   the flag is the fallback.
5. **Audio-back transport** — base64 in a JSON `speech` message (**recommend**; additive, small acks)
   vs binary server→client frames (promote later only if acks stream).
6. **Ack trigger** — deterministic milestone ack first (**recommend**) vs agent-driven `POST /speak`
   (follow-up once the route exists).
7. **Session sample rate** — 24 kHz mono per the current transcription-guide example (⚠ verify the
   allowed rates); resample client-side to match whatever the session declares.

## What in the current wire needs a breaking-ish change

Almost everything here is **additive** — a new `ChunkDescriptor` member, a new `LoweredMessage`-style
`speech` kind, a new `transcriber` enum value, a new `Transcriber` implementation — none of which bump
`PROTOCOL_VERSION` (the `chunk`/`kind` fields were designed additive, and their absence is the legacy
behavior every other format relies on). Two touches are more than additive and must be called out:

- **`StreamProcessor` needs a teardown hook** — the one genuine interface change. Today the processor
  contract is `onMessage` alone (`channel.ts:73`); there is no notification when the connection closes
  without a `fin`, and `web.ts`'s `socket.on("close")` only bumps a stat counter. A per-thread realtime
  session that a client abandons mid-turn (never fins, socket just drops) would **leak an upstream
  OpenAI WebSocket**. Add an optional `onClose()` / `dispose()` to `StreamProcessor`, called by the
  connection state machine for every live thread and driven from `web.ts`'s connection-close. Optional
  and back-compatible (text-concat ignores it), but it touches the processor contract, `channel.ts`,
  and `web.ts` in lockstep.
- **The `audio` chunk kind is a wire contract touched in three places at once** — `frame.ts` (channel),
  `protocol.ts` (the overlay's ~40-line re-implementation), and the protocol doc's `intent-v1` table.
  Additive, but if the three drift the streaming path silently breaks — treat it like the
  segments-as-lines contract: change all three together or not at all.

## Reading list

`workbench/docs/openai-audio-stack.md` (the L0–L3 ladder this promotes; §L1 realtime, §L2 audio-ack,
Q4 silence gating, Q5 audio-back) · `handoff/multimodal-intent-graduation.md` (the format, the seams,
the config design this builds on) · `docs/websocket-protocol.md` §`intent-v1` (the wire, the
`ChunkDescriptor`, the `lowered` push) · `workbench/docs/open-questions.md` (T6 latency = what L1
answers; T7 corrector) · `workbench/docs/field-notes.md` (segments-as-lines, the OpenAI
filename-extension sniff, the key story) · `packages/aiui/test/openai-pipeline.e2e.ts` (the capped-key
micro-e2e tier the realtime/TTS smokes mirror). OpenAI docs verified July 2026:
[Realtime transcription](https://developers.openai.com/api/docs/guides/realtime-transcription),
[Realtime VAD](https://developers.openai.com/api/docs/guides/realtime-vad),
[Text to speech](https://developers.openai.com/api/docs/guides/text-to-speech).

Non-OpenAI alternatives (noted, not designed for): Deepgram (Nova streaming STT over WebSocket with
interim results, sub-300 ms partials, and Aura TTS) is the strongest latency competitor; AssemblyAI,
Gladia, and Soniox also offer streaming STT. All fit behind the same `Transcriber` seam if the lab's
latency histograms ever say OpenAI realtime isn't fast enough — the seam is the point, so swapping the
vendor is a new implementation, not an architecture change.
