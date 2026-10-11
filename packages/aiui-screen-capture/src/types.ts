/** Region includes overlapping content; element isolates the element and its descendants. */
export type CropMode = "region" | "element";

export interface CaptureTarget {
  /** Element-only mode requires a boundary declared with ScreenCaptureTarget or captureTargetProps. */
  element: Element;
  label?: string;
  mode?: CropMode;
}

export interface CaptureOptions {
  /** Applied before the stream is exposed. Element targets require sharing this tab. */
  target?: CaptureTarget;
  /** Default false for full-surface capture; always true when a crop target is supplied. */
  preferCurrentTab?: boolean;
  /** Desired rate, not a promise about delivered frames. Default 30. */
  frameRate?: number;
}

export interface CaptureCapabilities {
  screen: boolean;
  region: boolean;
  element: boolean;
}

export interface CaptureSnapshot {
  state: "idle" | "requesting" | "active" | "error";
  /** A browser picker cannot be dismissed programmatically. A late grant is released. */
  requesting: boolean;
  cropping: boolean;
  muted: boolean;
  source?: { label: string; surface?: string };
  settings?: { width?: number; height?: number; frameRate?: number };
  crop?: { mode: CropMode; label: string; available: boolean; unavailableReason?: string };
  error?: string;
}

/** The acquisition/cropping seam for browser tests and alternative hosts such as Electron. */
export interface ScreenCaptureDriver {
  capabilities(): CaptureCapabilities;
  acquire(options: CaptureOptions): Promise<MediaStream>;
  /** Replace the target atomically without exposing an intermediate full surface. Do not stop the track. */
  applyTarget(
    track: MediaStreamTrack,
    target: CaptureTarget | null,
    previous?: CropMode,
  ): Promise<void>;
}

export interface ScreenCapture {
  /** Call directly from the user's gesture. Concurrent pickers are rejected. */
  start(options?: CaptureOptions): Promise<MediaStream | undefined>;
  /** Borrows the owned stream. Do not stop or clone its tracks while using native cropping. */
  stream(): MediaStream | undefined;
  /** The applied target, for controls that also reflect programmatic crop changes. */
  target(): CaptureTarget | undefined;
  snapshot(): CaptureSnapshot;
  capabilities(): CaptureCapabilities;
  /** Changes are serialized; null restores the whole selected surface. */
  setTarget(target: CaptureTarget | null): Promise<void>;
  /** Immediate state delivery, then updates. Returns an unsubscribe function. */
  subscribe(listener: (state: CaptureSnapshot) => void): () => void;
  stop(): void;
  dispose(): void;
}
