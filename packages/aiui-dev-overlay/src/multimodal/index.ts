/**
 * The multimodal intent modality and the reusable surfaces it hosts.
 *
 * Internal to the overlay's main entry (no dedicated subpath): the shipping
 * integration is `mountIntentTool` / `aiuiDevOverlay()`, which pick this
 * modality up by its `intent-v1` format. The individual pieces (Ink, ShotTool,
 * Preview, the transcriber/corrector seams, the layer STYLES) are exported so
 * an offline harness can drive them directly against its own mocks and
 * dev-proxy model calls — same surfaces, different host.
 *
 * @packageDocumentation
 */
export { AudioCapture } from "./audio";
export { Ink } from "./ink";
export { multimodalModality } from "./modality";
export { Preview } from "./preview";
export { locateComponents, type ShotPixels, type ShotSink, ShotTool } from "./shot";
export {
  type SpeechAudioElement,
  type SpeechAudioFactory,
  type SpeechClip,
  SpeechPlayer,
  type SpeechPlayerOptions,
} from "./speech";
export { STYLES as MULTIMODAL_STYLES } from "./styles";
export { mockTranscriber, type Transcriber, type TranscriptResult } from "./transcribe";
