/**
 * The multimodal tool's TALK stack as a subpath entry
 * (`@habemus-papadum/aiui-dev-overlay/multimodal-talk`) — host-agnostic by
 * construction (extracted to the shell in B2.4; zero window/document reads):
 * the extension's side panel composes the same lanes the overlay does.
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
export { createTalk, type Talk, type TalkDeps } from "./shell/talk";
export { type SpeechClip, SpeechPlayer } from "./speech";
export { mockTranscriber, type Transcriber } from "./transcribe";
