# Gemini & OpenAI Realtime: the Wire

The vendor internals behind [Realtime Live Mode](./realtime-live): what each engine actually
sends and receives, where the two are identical, where they differ, and the wire-level gotchas
the implementation paid for. The engines live in
`packages/aiui-claude-channel/src/{gemini-live,openai-live}.ts`, behind the `LiveSession` seam
(`live-session.ts`) — nothing outside those files speaks a vendor dialect.

::: tip Both engines are WebSockets
A common misreading: OpenAI's Realtime API is **not** REST. Both vendors hold one long-lived,
stateful WebSocket per thread — audio streams up in small increments as you speak, and nothing
already sent is ever re-uploaded. What differs is the *state model on top of the socket*
(streams vs. a conversation of items), not the transport. Transcription is a *third* WebSocket
dialect in this project — the streaming STT session (`realtime.ts`) every tier uses. (OpenAI
also offers WebRTC and SIP transports for browser-direct and telephony clients; the channel is
a server, so it speaks the WebSocket.)
:::

## Identical across both vendors

The engines share everything above the dialect: mic-only PCM16 at 24 kHz (base64 over the
socket), manual VAD with push-to-talk boundaries, the same `read_file` tool, the same
[linter persona](./prompt-linting#the-prompt) (`LINTER_INSTRUCTIONS` — one authoritative
instruction text), the same `[image shot_N]` / `[selection sel_N: …]` /
`[transcript seg_N: …]` label grammar, silent context injection, WAV-wrapped reply clips,
**output transcription** (the reply text that becomes the `linter-note` — there is no vendor
*input* transcription: the STT session owns the chronicle), and per-turn usage accounting. The
unit tests drive both through the same injectable fake-socket seam.

## Gemini Live — the reference engine

A raw WebSocket to `v1beta BidiGenerateContent` (API key on the query string — deliberately
**not** the `@google/genai` SDK; see gotchas). One `setup` frame configures everything: audio
output, input+output transcription, manual VAD, the tool, session resumption, and
**sliding-window context compression** (so a long session survives the API's session caps).
Then the session is a set of **media streams**:

- `realtimeInput.audio` — mic PCM, framed by explicit `activityStart`/`activityEnd` signals.
- `realtimeInput.video` — image frames: labeled shots (the `[image shot_N]` text frame
  immediately followed by the image frame) — which since the frames-are-shots pivot includes
  the share's sampled JPEG frames — plus, from legacy overlays, unlabeled ambient JPEGs.
  There is **no interleaving structure** between audio and video — they are independent
  stream fields on one socket; temporal alignment is the model's problem.
- `clientContent` turns with `turnComplete: false` — the silent context append (selections).

Replies come back as `serverContent` — `outputTranscription` fragments and audio parts —
bounded by `turnComplete` (Gemini has no response ids; the engine buffers per turn and flushes
one reply clip and one reply transcript). Tool calls arrive as `toolCall.functionCalls`; the
`toolResponse` answer resumes the model on its own. Capabilities:
`{ video: true, imageInjection: "stream" }`.

## OpenAI Realtime — items, not streams

Also a WebSocket — `wss://api.openai.com/v1/realtime?model=…`, bearer-authed, configured by
one `session.update`. But where Gemini is streams into a session, OpenAI is a **stateful
conversation of items** over the socket:

- Audio is *incremental but buffered*: `input_audio_buffer.append` per frame while you talk,
  then `input_audio_buffer.commit` + `response.create` at talk-end. The server holds the
  buffer; nothing is resent.
- Images and text join as `conversation.item.create` **items** — a labeled shot is one item
  with an `input_text` part (`[image shot_N]`) and an `input_image` data-URL part. Items never
  auto-trigger a response, which is exactly what silent selection injection relies on.
- Replies are keyed by response id: `response.output_audio.delta` (base64 PCM chunks, buffered
  and WAV-wrapped at `response.done`), transcript deltas, and `response.done` carrying usage
  and any `function_call` item (`read_file`). The tool answer is a `function_call_output` item
  **followed by an explicit `response.create`** — a written tool result never resumes the
  model on its own.
- **The commit floor:** the upstream rejects `input_audio_buffer.commit` under ~100 ms of
  buffered audio ("buffer too small"), killing the turn — so a tapped-and-released window is
  **cleared**, never committed, and no lint is solicited for an accidental tap.

**Video rides as items** (`{ video: true, imageInjection: "turn-item" }`): ambient frames
inject as unlabeled `input_image` items. Every item appends permanently to the conversation
and is re-billed as input on every subsequent response — and OpenAI has no equivalent of
Gemini's sliding-window compression — which is exactly why the sampler defaults to one frame
per **five seconds** rather than per second, and why the slider exists.

## Wire gotchas — the vendor field ledger

- **Gemini's window rule (undocumented):** a manual-VAD activity window must **open with
  audio** — a text label or video frame sent inside a window before any audio hard-closes the
  socket with `1007`. The `WindowOrderingGuard` queues non-audio frames until the window's
  first audio chunk.
- **Gemini answers bare text immediately** under manual VAD — so silent context (selections,
  the `[transcript seg_N]` items) must ride `clientContent` with `turnComplete: false`, never
  `realtimeInput.text`.
- **Raw WebSocket, not the `@google/genai` SDK:** the SDK's wire transformer silently drops
  `realtimeInputConfig` from the setup frame, which makes manual VAD impossible (activity
  signals then die with `1007`).
- **Gemini states its faults in the close frame** (`reason` carries "API key not valid…");
  OpenAI in `error` events and rejected-handshake HTTP bodies. Both are captured and surfaced —
  a bare "session closed" would discard the actual cause.
- **Audio rate:** the client captures 24 kHz; Gemini natively wants 16 kHz but accepts any
  *declared* rate (`audio/pcm;rate=24000`) and resamples server-side — verified live, so there
  is no channel-side resampler.
- **OpenAI GA vs. Beta shape:** the Beta wire shape (`OpenAI-Beta: realtime=v1`,
  `transcription_session.update`) is disabled upstream; the GA shape (`session.update` with a
  nested typed session, bearer-only auth) is what runs.
- **OpenAI items never auto-trigger a response** — every reply needs an explicit
  `response.create`. Forgetting the first fact breaks silent injection; forgetting the second
  makes the model permanently silent.
- **Session lifetime:** Gemini enforces session caps and warns via `goAway`; setup requests a
  resumption handle, but reconnect-on-GoAway is not implemented — the warning is surfaced and
  the session ends with the thread.

## Research note: why transcription is OpenAI-only

Gemini was evaluated (July 2026) as a second *streaming transcription* vendor and rejected for
now: the Live API never streams input-transcription deltas (one text per turn, flushed at
`turnComplete`) and has no transcription-only mode — every turn bills a full model response,
with per-turn context re-billing and a ~15-minute session cap. Google Cloud STT v2's
`StreamingRecognize` does stream interim results, but it is gRPC-only with service-account
auth (no API-key path) at roughly 5× OpenAI's price, and would need its own server-side
bridge. The `RealtimeSession` seam in `realtime.ts` is where a second vendor slots if Google
ships input-delta streaming or a transcription intent; until then, `linter: "gemini"` runs
only the linter session on Gemini while transcription stays on OpenAI.
