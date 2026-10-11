/** A PCM producer. Stopping it releases this subscription, not necessarily the device. */
export interface AudioSource {
  readonly sampleRate: number;
  start(onFrame: (pcm16: Uint8Array) => void): Promise<void>;
  stop(): void;
  /** A capture fence: all samples before this call arrive before it resolves. */
  flush?(): Promise<void> | void;
  level?(): number;
}

export interface AudioIdentity {
  id: string;
  label: string;
  /** A short glyph; labels always accompany icons. */
  icon?: string;
}

export type InputSource =
  | { kind: "microphone"; deviceId?: string; constraints?: MediaTrackConstraints }
  | { kind: "recording"; samples: Float32Array; sampleRate: number; loop?: boolean };

/** Browser mechanics are injected so routing/lifecycle tests need no hardware. */
export interface AudioDriver {
  capture(source: InputSource, signal: AbortSignal, onEnded: () => void): Promise<() => void>;
  route(id: string | undefined): Promise<void>;
  flush(): Promise<void>;
  stream(id: string): MediaStream;
  removeStream(id: string): void;
  level(): number;
  settings(): MediaTrackSettings | undefined;
  applyConstraints(constraints: MediaTrackConstraints): Promise<void>;
  onPcm(callback: (id: string, samples: Float32Array, sampleRate: number) => void): void;
  dispose(): void;
}

export interface InputEndpoint extends AudioIdentity {
  readonly kind: "pcm" | "stream";
  /** Consumer readiness only. Never selects a route or opens the microphone. */
  setEnabled(enabled: boolean): void;
  dispose(): void;
}
export interface PcmInput extends InputEndpoint, AudioSource {
  readonly kind: "pcm";
}
export interface StreamInput extends InputEndpoint {
  readonly kind: "stream";
  /** Stable, hub-owned track. Consumers must not stop it. */
  stream(): MediaStream;
  settings(): MediaTrackSettings | undefined;
  applyConstraints(constraints: MediaTrackConstraints): Promise<void>;
}
export interface AudioOutput extends AudioIdentity {
  attach(stream: MediaStream, element?: HTMLAudioElement): void;
  detach(): void;
  dispose(): void;
}
export interface AudioSnapshot {
  capture: "off" | "starting" | "active" | "error";
  source: "microphone" | "recording";
  deviceId: string;
  error?: string;
  parked: boolean;
  selectedInput?: string;
  /** The applied route, not merely the user's selection. */
  activeInput?: string;
  inputs: readonly (AudioIdentity & { kind: "pcm" | "stream"; enabled: boolean })[];
  outputs: readonly (AudioIdentity & { attached: boolean })[];
  selectedOutput?: string;
  outputMuted: boolean;
  volume: number;
  sinkId: string;
  playbackBlocked: boolean;
}
