/** ElevenLabs realtime dictation. Audio comes from aiui-audio or an injected PCM source;
 * credentials come from a fresh connectUrl callback. LiveDiffText lives in aiui-viz/modal. */

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
