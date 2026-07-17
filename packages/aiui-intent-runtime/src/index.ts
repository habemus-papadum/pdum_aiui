/**
 * The intent client's host-agnostic **capture + transport runtime** — the
 * live half of what the retired dev overlay carved out for its two hosts
 * (copied here in the overlay retirement; the original is deleted — read it
 * in git history).
 *
 * The discipline every module keeps: a DOM-free, framework-free *core* (a
 * state machine, an algorithm, a batching loop) with the thin browser *edge*
 * injected as a dependency (`PcmSource`, `VideoSamplerDeps.captureFrame`,
 * `WireDeps`), so the cores run in plain Node under Vitest with a fake edge
 * and the real edge is supplied only in a live tab. Losing that split makes
 * this untestable — keep it.
 *
 * This root entry is the shared substrate; the jobs ride subpath entries:
 *
 *  - `./locator` — the component locator
 *    (screenshot-rect → components → source, off the source-processor stamps)
 *  - `./talk` — the audio stack: mic → PCM (AudioWorklet), REST segments,
 *    realtime PCM streaming, TTS playback with barge-in, offline transcriber
 *  - `./video` — the screen-share frame sampler over a warm capture stream
 *  - `./selection` — the "select on the page, then ask about it" watcher
 *  - `./wire` — the per-thread socket: batched event log, shots/audio/PCM
 *    uploads, lowered echoes merged back in
 *  - `./thread` — the host-agnostic intent-thread adapter over `./protocol`'s
 *    socket client
 *
 * @packageDocumentation
 */

export type { AddErrorOptions, IntentError, IntentErrorInput } from "./errors";
export { addError, dismissError, ERROR_TOAST_CAP, formatErrorData } from "./errors";
export type {
  ClientMeta,
  CollectClientMetaOptions,
  FrameMetric,
  PageInstrumentation,
  PageTabRecord,
  TabInfo,
} from "./instrumentation";
export {
  ACTOR_STORAGE_KEY,
  collectClientMeta,
  getInstrumentation,
  pageTabRecord,
  recordFrameMetric,
  setChannelPort,
  TAB_DATASET_KEY,
} from "./instrumentation";
export type { IntentThread, OpenThreadOptions } from "./intent-types";
export type {
  Ack,
  AttachmentChunk,
  AudioChunk,
  ErrorMessage,
  FrameChunk,
  IntentSocket,
  JsonChunk,
  LoweredPromptMessage,
  ServerMessage,
  VideoChunk,
  WebSocketFactory,
  WebSocketLike,
} from "./protocol";
export {
  connectIntentSocket,
  encodeFrame,
  encodeJsonPayload,
  isErrorMessage,
  PROTOCOL_VERSION,
} from "./protocol";
