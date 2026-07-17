/**
 * The TALK stack as a subpath entry
 * (`@habemus-papadum/aiui-intent-runtime/talk`) — host-agnostic by
 * construction (zero window/document reads in the lanes): the CDP tier and
 * the MV3 side panel compose the same lanes.
 *
 *  - {@link createTalk} — both capture lanes behind talkStart/talkEnd: REST
 *    segments (AudioCapture → `seg_N` attachment) and realtime PCM streaming
 *    (`uploadAudio` frames), chosen per talk from the live config.
 *  - {@link WorkletPcmSource} — mic → Int16 PCM frames via AudioWorklet.
 *  - {@link SpeechPlayer} — server-pushed TTS clips, with barge-in.
 *  - {@link mockTranscriber} — the offline tier's local transcriber.
 */
export {
  AudioCapture,
  PCM_WORKLET_SOURCE,
  type PcmSource,
  REALTIME_PCM_MIME,
  REALTIME_PCM_RATE,
  WorkletPcmSource,
} from "./audio";
export { type SpeechClip, SpeechPlayer } from "./speech";
export { createTalk, type Talk, type TalkDeps } from "./talk-lanes";
export { mockTranscriber, type Transcriber } from "./transcribe";
