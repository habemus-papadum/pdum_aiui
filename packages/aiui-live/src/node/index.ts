/** Node-only pieces: the WebSocket transport, a scripted user (speech
 * synthesis + a real-time mic), and the host-neutral backend (session broker
 * + delegation relay). Browser code never imports this subpath. */
export type {
  DelegatorContext,
  DelegatorFactory,
  LiveBackend,
  LiveBackendOptions,
  SessionOutcome,
} from "./backend.ts";
export { createLiveBackend, runLiveServer, sessionOutcome } from "./backend.ts";
export type { ScriptedMic, ScriptedMicOptions, SynthesizeOptions } from "./speech.ts";
export { PCM_RATE, pcmToWav, scriptedMic, synthesize, wavSink } from "./speech.ts";
export type { AudioSource, WebSocketTransportOptions } from "./ws-transport.ts";
export { webSocketTransport } from "./ws-transport.ts";
