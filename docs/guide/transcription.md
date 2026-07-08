# The Transcription Layer

Speech-to-text is the intent pipeline's highest-traffic model seam, and "transcription API" is
not one kind of thing. This page is the conceptual map: the two interaction shapes, the three
engines behind the strip's picker, what each returns beyond text (word timestamps, confidence),
and how the compiler and preview consume those extras.

## Two interaction shapes, not one

- **Request-response** — record a whole segment, upload it, get text back. One bounded
  round-trip per Space release; latency is the whole round trip (~1–1.5 s floor). OpenAI's
  `/v1/audio/transcriptions` endpoint (`gpt-4o-transcribe`, `gpt-4o-mini-transcribe`,
  `whisper-1`) is this shape — even its `stream=true` variant only streams the *response* of an
  already-complete upload.
- **Streaming** — hold a WebSocket session, stream PCM as the user speaks, receive partial
  transcripts *while they talk* and a final shortly after the commit. OpenAI's realtime
  transcription session (`gpt-realtime-whisper`) and ElevenLabs' Scribe v2 realtime are this
  shape.

The strip's picker (<kbd>K</kbd>, digits) presents engines by this shape, because it is the
property you actually feel:

| Engine | Shape | Notes |
| --- | --- | --- |
| ⚡ **Realtime Whisper** *(the fallback)* | streaming | `gpt-realtime-whisper` over the realtime WS. Tunable `realtimeDelay` (latency ↔ accuracy); **defaults to `xhigh`**. No prompt/keyword support, and — probed live — **no logprobs**, `include` or not: no heat map on this engine. |
| 🎯 **GPT-4o Transcribe** | streaming | `gpt-4o-mini-transcribe` **over the same realtime WS** — probed live: it streams deltas AND returns token logprobs, so this is the confidence-heat-map engine. (The REST request-response form stays config-only: `transcriber: "openai"`.) |
| 🎬 **Scribe v2** *(default when available)* | streaming | ElevenLabs `scribe_v2_realtime`. Word-level **timestamps + logprobs** on every final, `keyterms` biasing, `no_verbatim` (fillers stripped). Needs `ELEVEN_LABS_API_KEY` in the channel's environment. |

`mock` remains the offline/test engine (config-only, not in the strip).

**The default is availability-aware:** the shipped config asks for Scribe v2 (the richest
engine — word timestamps *and* logprobs); a channel without `ELEVEN_LABS_API_KEY` falls back
to Realtime Whisper with a visible note ("🎬 Scribe unavailable — transcribing with ⚡
Realtime Whisper"), recorded as a coercion on the trace's `intent config` stage. Neither key →
the usual loud keyless posture.

## What comes back beyond text

`transcript-final` events can carry `words[]` — per-word `startMs`/`endMs` (milliseconds into
**the segment's own audio**, whose first sample is the talk-start instant) and `logprob`
(model confidence) — whenever the engine reports them. Two consumers:

- **The compiler's media anchors.** A screenshot's `takenAt` (gesture wall-clock) converts to
  an exact text offset: the last word whose `talk-start + startMs` precedes the gesture. This
  *replaces* the delta-arrival latency estimate (see below) when words are present — no
  estimation, the vendor measured it against the audio itself.
- **The confidence heat map.** The preview renders low-confidence words with a warm tint. The
  gradation is a derived Solid cell: one memo folds the logprob **range across everything the
  turn has transcribed so far**, and each word normalizes against that range — relative to the
  turn's own distribution, since absolute logprob bands differ per vendor. Hover a word for
  its raw logprob. Low-confidence tinting marks exactly the words worth re-speaking (or that
  the [prompt linter](./prompt-linting) will flag).

Engine support today (all probed live, July 2026): **Scribe v2** reports both timestamps and
logprobs. **`gpt-4o-mini-transcribe` over the realtime session** reports token logprobs
(requested via `include: ["item.input_audio_transcription.logprobs"]`, folded to word level —
a word's confidence is its worst token) but no timestamps. **`gpt-realtime-whisper` reports
neither** — the `include` is accepted and silently ignored. The request-response models
reserve `timestamp_granularities[]` for `whisper-1` only. So the exact-anchor path is
ElevenLabs-first, and the heat map lights on Scribe and GPT-4o Transcribe.

### The latency-estimate fallback

Without word timestamps, the compiler estimates how far transcript deltas *trail* the speech
they transcribe, from the stream itself: preferring the **tail** anchor (how long after the
Space release the last delta arrived — onset-free), falling back to the **head** anchor
(window-open to first delta, which over-counts the user's speech-onset delay), then a fixed
800 ms default, clamped at 2 s. Split offsets nudge to a word end and past a sentence end just
ahead (dictation pauses cluster at sentence seams). This is deliberately an estimate — the
open research direction is per-word audio alignment, which is exactly what the `words[]` path
delivers where available.

## Keywords (the vocabulary slot)

`keywords: string[]` in the pipeline config is the domain-vocabulary bias slot — product
names, acronyms, identifiers. Nothing in the UI writes it yet; it is deliberately a
config-only slot with per-engine wiring:

- **GPT-4o Transcribe**: joins into the REST `prompt` ("Keywords: …" — short lists work
  best; ~224-token budget on whisper-family models).
- **Scribe v2**: maps to `keyterms[]` query params.
- **Realtime Whisper**: *not supported* by the vendor (GA realtime sessions reject `prompt`);
  the slot is documented-inert there.

A likely future source: the page's component names and the session's file paths, fed
automatically — the same instrumentation the locator reads.

## Wire dialects, briefly

Three dialects, one seam (`RealtimeSession` in the channel; the REST transcriber is its own
narrow seam):

- **OpenAI realtime transcription** (`realtime.ts`): `session.update` with
  `type: "transcription"`, manual VAD, `input_audio_buffer.append`/`commit`,
  `conversation.item.input_audio_transcription.delta`/`completed`, `item_id` correlation.
- **ElevenLabs Scribe v2** (`elevenlabs-realtime.ts`): `xi-api-key` auth, config in the URL
  query, `input_audio_chunk {audio_base_64, commit, sample_rate}` frames,
  `partial_transcript` / `committed_transcript_with_timestamps` back. **No item ids** —
  commits complete FIFO — and **no buffer-clear message**. `no_verbatim=true` strips fillers
  ("um") at the source (measured: the filler word and its spacing entry vanish).
- **OpenAI REST** (`transcribe.ts`): multipart upload per segment; `json` response.

### What the live experiments measured (Scribe v2, July 2026)

The protocol questions were answered empirically (full timelines:
`.aiui-cache/scribe-findings.md`):

- **It is genuinely streaming, not batch-per-turn.** Partials flow on a fixed **~1 s server
  cadence** (~2.2 s to the first one, content lagging the live audio edge by ~200–400 ms)
  regardless of commit strategy — with *zero* commits, or with a VAD threshold high enough
  that no turn boundary ever fires, the partial just keeps growing. Turn detection only
  controls when a *committed* transcript is emitted.
- **Commit → final is fast:** ~180–210 ms to `committed_transcript`, the timestamped variant
  ~100 ms behind it. Partials reset to the next utterance after a commit.
- **VAD commit** auto-commits after ≥ `vad_silence_threshold_secs` of silence (default 1.5 s;
  0.8 s segments more aggressively) — but **never commits the trailing utterance** unless the
  silence outlasts the threshold, so an end-of-speech manual `commit` is required regardless.
  We keep **manual** commit: push-to-talk *is* our turn boundary, and the append-only pivot
  removed client-side endpointing on purpose.
- **The socket idles out in ~15 s.** ElevenLabs closes an idle Scribe session ~15 s after
  `session_started` (code 1000, empty reason) — and the channel opens the session eagerly at
  thread-open, so think-time before speaking used to kill it. The session keeps itself alive
  with an empty-chunk heartbeat every 10 s of outbound silence (an empty chunk resets the
  server's idle timer while adding zero bytes — the cumulative word-timestamp timeline and
  the commit floor are untouched, verified live).
- **`commit_throttled` is fatal.** A commit with < 0.3 s of uncommitted audio doesn't just
  fail — the server closes the WebSocket. The session therefore gates every commit behind a
  local 500 ms audio floor (an under-floor tap resolves as an empty final, never a wire
  commit), and "discard" keeps the stray audio in the buffer rather than committing it —
  the ≤ 0.3 s of near-silence prepending the next utterance is the accepted tradeoff, since
  the only true buffer reset is a reconnect.
- **Word timestamps are seconds on the session's CUMULATIVE audio timeline** — they do not
  reset per commit. The session converts to per-segment `startMs` by subtracting the audio
  streamed before the segment began. Per-character timings and `speaker_id` also ride along.
- **Logprobs are natural-log, observed ≈ −1.26…0**, with fillers and sentence-initial words
  most negative — which is exactly why the heat map normalizes against the turn's own range
  rather than an absolute scale.
- **`keyterms` must be repeated plain params** (`keyterms=a&keyterms=b`); the bracket form is
  *silently ignored*, and unknown params never error — the `session_started` config echo is
  the only reliable confirmation that a knob took effect.

## See also

- [Using the Intent Overlay](./intent-overlay) — the strip, the preview, the keys.
- [Prompt Linting](./prompt-linting) — the realtime observer that consumes the same turn.
- [Realtime: the Wire](./realtime-vendors) — the linter-session dialects and the research
  note on why Gemini can't power transcription today.
