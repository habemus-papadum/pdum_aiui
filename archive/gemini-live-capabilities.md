# Gemini Live API — capabilities reference (curated copy)

> Source: https://ai.google.dev/gemini-api/docs/live-api/capabilities (Preview), pasted by the
> user July 2026 and curated here for the realtime-submode builders. Python samples, the
> boilerplate JS queue scaffolding, and the 97-language table are elided; everything
> load-bearing is verbatim. **Live-verified findings on top of this doc live in
> `gemini-live-spike.mjs` (same directory) — read those first; one of them (activity windows
> must open with audio) is not documented here.**

## Model comparison (3.1 Flash Live Preview vs 2.5 Flash Live Preview)

| Feature | Gemini 3.1 Flash Live Preview | Gemini 2.5 Flash Live Preview |
|---|---|---|
| **Thinking** | `thinkingLevel`: `minimal` (default, lowest latency) / `low` / `medium` / `high` | `thinkingBudget` token count; dynamic by default; `0` disables |
| **Receiving response** | ONE server event can carry MULTIPLE content parts (e.g. `inlineData` + transcript) — process all parts per event | one content part per event |
| **Client content** | `sendClientContent` ONLY for seeding initial history (requires `initial_history_in_client_content` in `history_config`); mid-conversation text goes via `sendRealtimeInput({text})` | `sendClientContent` works throughout |
| **Turn coverage** | Defaults to `TURN_INCLUDES_AUDIO_ACTIVITY_AND_ALL_VIDEO` — the model's turn includes detected audio activity and ALL video frames | `TURN_INCLUDES_ONLY_ACTIVITY` |
| **Custom VAD** (`activityStart`/`activityEnd`) | Supported | Supported |
| **Automatic VAD configuration** | Supported (`start/end_of_speech_sensitivity`, `prefix_padding_ms`, `silence_duration_ms`) | Supported |
| **Async function calling** (`behavior: NON_BLOCKING`) | NOT supported — sequential only; model waits for the tool response | Supported, with `scheduling`: `INTERRUPT` / `WHEN_IDLE` / `SILENT` |
| **Proactive audio** (model may choose not to respond) | NOT supported | Supported — `proactivity: { proactive_audio: true }`, requires `v1alpha` |
| **Affective dialogue** | NOT supported | Supported — `enable_affective_dialog: true`, requires `v1alpha` |

## Connection (JS SDK shown; NOTE: we use raw WS — see spike finding #1)

```js
import { GoogleGenAI, Modality } from '@google/genai';
const ai = new GoogleGenAI({});
const session = await ai.live.connect({
  model: 'gemini-3.1-flash-live-preview',
  callbacks: { onopen, onmessage, onerror, onclose },
  config: { responseModalities: [Modality.AUDIO] },
});
```

Raw endpoint (what the spike/channel use):
`wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=KEY`
— first frame `{setup: {model: "models/…", generationConfig, systemInstruction, tools,
realtimeInputConfig, inputAudioTranscription, outputAudioTranscription, …}}`, answered by
`{setupComplete: {}}`.

## Modalities

- **Audio in**: raw little-endian 16-bit PCM; natively 16 kHz but any rate accepted — declare it
  in the blob MIME: `sendRealtimeInput({ audio: { data: b64, mimeType: 'audio/pcm;rate=16000' } })`.
- **Audio out**: always 24 kHz PCM16, as `serverContent.modelTurn.parts[].inlineData` chunks.
- **Text in**: `sendRealtimeInput({ text: '…' })`. (3.1: this is the ONLY mid-conversation text path.)
- **Video in**: individual images (JPEG or PNG), **max 1 frame per second**:
  `sendRealtimeInput({ video: { data: b64, mimeType: 'image/jpeg' } })`.
- Incremental `sendClientContent({turns, turnComplete})` — 3.1: initial seeding only (see table).
  For long contexts, prefer a single summary message; see Session Resumption.

## Audio transcriptions

Setup config: `outputAudioTranscription: {}` (model speech → `serverContent.outputTranscription.text`)
and `inputAudioTranscription: {}` (user audio → `serverContent.inputTranscription.text`).
Languages are auto-inferred.

## Voice & thinking

- Voice: `speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } }` (any TTS voice).
- Native-audio models pick language automatically (no explicit code; restrict via system instructions).
- Thinking (3.1): `thinkingConfig: { thinkingLevel: 'minimal'|'low'|'medium'|'high' }`
  (default `minimal`); optional `includeThoughts: true` for thought summaries.

## Voice Activity Detection

- **Interruptions**: VAD-detected barge-in cancels generation; server reports
  `serverContent.interrupted` (stop local playback, clear queues); pending function calls are
  discarded and their cancelled IDs reported.
- **Automatic VAD** (default): configure via
  `realtimeInputConfig.automaticActivityDetection: { disabled, startOfSpeechSensitivity,
  endOfSpeechSensitivity, prefixPaddingMs, silenceDurationMs }`.
  If the audio stream pauses > ~1 s, send `{ audioStreamEnd: true }` to flush; resume anytime.
  `silenceDurationMs` guidance: 500–800 ms recommended (server default ≈800); 100–200 ms
  fragments utterances and degrades quality; 2000+ ms adds latency.
- **Manual VAD**: `automaticActivityDetection: { disabled: true }`, then frame turns with
  `sendRealtimeInput({ activityStart: {} })` … audio … `({ activityEnd: {} })`. No
  `audioStreamEnd` in this mode. **Caveats**: no server pre-speech buffer (include your own
  pre-roll before/at activityStart) and no silence tolerance (server acts immediately on
  activityEnd) — use a client end-of-speech threshold ≥ **500 ms** (ours is 900 ms).
  **Spike finding: the window must OPEN with audio; text/video may only follow audio.**

## Token count / media resolution

- `usageMetadata` rides server messages periodically: `totalTokenCount` +
  `responseTokensDetails[]` per modality.
- `mediaResolution: MEDIA_RESOLUTION_LOW | …` in session config controls input media resolution.

## Limitations

- Native-audio models support ONLY the `AUDIO` response modality (use output transcription for text).
- Server-to-server auth only by default; browser-direct needs ephemeral tokens (our design keeps
  the socket channel-side, so plain API key is fine).
- **Session duration: 15 min audio-only, 2 min audio+video** — extendable via session management
  (context window compression + resumption; see the live-session guide).
- Context window: 128k tokens (native audio models).

*(Elided: 97-language table; live-translation pointer; cookbook links.)*
