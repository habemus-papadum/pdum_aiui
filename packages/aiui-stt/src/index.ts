/**
 * @habemus-papadum/aiui-stt — realtime speech-to-text as a pencil-shaped
 * component. Contract of record: the aiui-stt proposal (pdum_aiui git
 * history); the wire facts underneath are the channel's, hard-won and ported
 * verbatim (see each engine module's header).
 *
 * The contract is the pencil's, with text in place of ink: start a session,
 * feed it audio, watch a stream of CUMULATIVE text deltas, and know when a
 * segment is final. **The default engine is ElevenLabs Scribe v2 realtime**
 * ({@link scribeTransport}); the OpenAI `transcription`-type realtime flavor
 * ({@link openaiTranscriptionTransport}) is the alternate. Both sit behind
 * one seam ({@link SttTransport} → {@link SttConnection}), so the vendor
 * difference is confined to the open.
 *
 * Credentials are injected, never owned (D3): Scribe takes a
 * `connectUrl()` minting one single-use token per connect; OpenAI takes the
 * oracle's `KeySource`. Audio is injected too (D4): an {@link AudioSource}
 * of 24 kHz PCM16 frames — `aiui-stt/mic` ships the real microphone; a test
 * or a file player is the same seam. Display is `LiveDiffText`
 * (aiui-viz/modal) — this package ships no renderer (D6).
 */

export type { OpenaiTranscriptionTransportOptions } from "./openai";
export {
  DEFAULT_OPENAI_TRANSCRIPTION_MODEL,
  OPENAI_CAPABILITIES,
  OPENAI_REALTIME_URL,
  openaiTranscriptionSession,
  openaiTranscriptionTransport,
  wordsFromTokenLogprobs,
} from "./openai";
// reactive.ts — the Solid face: signals over the handle's event stream (D5).
export type { SttSegmentFinal, SttSignals } from "./reactive";
export { sttSignals } from "./reactive";
export type { ScribeTransportOptions } from "./scribe";
// scribe.ts — the DEFAULT engine (ElevenLabs Scribe v2 realtime).
export {
  DEFAULT_SCRIBE_MODEL,
  SCRIBE_CAPABILITIES,
  SCRIBE_COMMIT_FLOOR_MS,
  SCRIBE_KEEPALIVE_MS,
  SCRIBE_SAMPLE_RATE,
  scribeTransport,
} from "./scribe";
// stt.ts — the handle: push-to-talk segments over one transport.
export type { CreateSttOptions, SttHandle } from "./stt";
export { createStt, DEFAULT_DRAIN_TIMEOUT_MS } from "./stt";
// support.ts — the injectable socket seam (tests script it; hosts rarely need it).
export type { SttSocket, SttSocketFactory, SttSocketHandlers } from "./support";
export { browserSocketFactory } from "./support";
export type {
  AudioSource,
  SttCallbacks,
  SttCapabilities,
  SttConnection,
  SttDiagnostic,
  SttEvent,
  SttFinal,
  SttStatus,
  SttTransport,
  SttWord,
} from "./types";
