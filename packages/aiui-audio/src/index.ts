/** Shared audio device ownership. Sessions borrow endpoints; only the hub owns capture. */

export {
  AUDIO_WORKLET_SOURCE,
  type BrowserAudioOptions,
  browserAudioDriver,
  ECHO_SAFE_AUDIO,
} from "./browser";
export {
  type AudioHub,
  type AudioHubOptions,
  activateSessionAudio,
  createAudioHub,
  type SessionAudio,
} from "./hub";
export { floatToPcm16, resampleLinear } from "./pcm";
export { claimSessionAudio } from "./session";
export type {
  AudioDriver,
  AudioIdentity,
  AudioOutput,
  AudioSnapshot,
  AudioSource,
  InputEndpoint,
  InputSource,
  PcmInput,
  StreamInput,
} from "./types";
