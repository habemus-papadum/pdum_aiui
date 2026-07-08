/**
 * The realtime submode's ambient screen sampler.
 *
 * While the user is "sharing" (V, in a live tier) the modality draws the
 * ShotTool's display-capture stream to a canvas about once a second, encodes a
 * downscaled JPEG, and streams it as a `video` chunk — unlabeled ~1 fps context
 * for the live model (deliberate shots stay the *referenceable* artifacts; the
 * frames just tell the model what the screen currently looks like).
 *
 * This file is the framework-free, DOM-free core: the sizing math
 * ({@link sampleDimensions}) and the cadence/toggle state machine
 * ({@link VideoSampler}). The pixel work — draw + `toBlob` — is injected as
 * {@link VideoSamplerDeps.captureFrame}, so the machine is unit-testable in
 * plain Node with a fake capture (jsdom has no real canvas), and the modality
 * owns the canvas plumbing next to its ShotTool.
 */

/** The fallback frame cadence when none is configured (ms per frame). The
 * shipped default is `videoFrameIntervalMs` (5000 — one frame every five
 * seconds; the share's slider adjusts it live). */
export const VIDEO_SAMPLE_INTERVAL_MS = 1000;
/** Frames are downscaled to at most this width (aspect kept) before encoding. */
export const VIDEO_MAX_WIDTH = 1024;
/** JPEG quality for a sampled frame — small enough for 1 fps, legible enough to ground on. */
export const VIDEO_JPEG_QUALITY = 0.6;
/** MIME the `video` chunks declare (a sampled frame is a JPEG image). */
export const VIDEO_FRAME_MIME = "image/jpeg";

/**
 * Downscaled frame dimensions: cap the width at `maxWidth`, keep the aspect
 * ratio, and **never upscale** (a small capture stays its own size). Pure —
 * `srcWidth`/`srcHeight` are the video element's intrinsic size. A non-positive
 * source (metadata not loaded yet) yields `0×0`; the caller clamps to ≥1 so a
 * not-yet-ready element still produces a (tiny, harmless) frame rather than
 * throwing.
 */
export function sampleDimensions(
  srcWidth: number,
  srcHeight: number,
  maxWidth: number = VIDEO_MAX_WIDTH,
): { width: number; height: number } {
  if (srcWidth <= 0 || srcHeight <= 0) {
    return { width: 0, height: 0 };
  }
  const width = Math.min(srcWidth, maxWidth);
  const height = Math.max(1, Math.round((width / srcWidth) * srcHeight));
  return { width: Math.round(width), height };
}

/** The pixel + delivery seams the {@link VideoSampler} drives. */
export interface VideoSamplerDeps {
  /**
   * Capture one downscaled JPEG frame of the shared screen, or `undefined` when
   * the capture surface isn't available right now (grant denied/ended). Async:
   * the first call may acquire the one-time display-capture grant.
   */
  captureFrame(): Promise<Uint8Array | undefined>;
  /** Deliver one captured frame with its per-share `seq` (increasing from 0). */
  sendFrame(seq: number, bytes: Uint8Array): void;
  /**
   * Sampling cadence in ms — a number, or a THUNK read before each tick so a
   * live config change (the share's fps slider) takes effect on the very
   * next frame without restarting the share. Defaults to
   * {@link VIDEO_SAMPLE_INTERVAL_MS}.
   */
  intervalMs?: number | (() => number);
}

/**
 * The share cadence + toggle/pause state machine. One share is a `start()` …
 * `stop()` span, during which frames stream at the interval with a `seq`
 * counting from 0 (a new share resets it — the modality bumps the `vid_N`
 * ordinal in parallel). `pause()`/`resume()` (window blur/focus) hold and
 * continue sampling *without* ending the share, so a glance away doesn't drop
 * the context and refocus picks it right back up.
 */
export class VideoSampler {
  private readonly deps: VideoSamplerDeps;
  private _sharing = false;
  private paused = false;
  private seq = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** Guards against overlapping ticks when a `captureFrame` outlives its interval. */
  private inFlight = false;

  constructor(deps: VideoSamplerDeps) {
    this.deps = deps;
  }

  /** True while a share is active (whether or not it is momentarily paused). */
  get sharing(): boolean {
    return this._sharing;
  }

  /** Begin a share: reset the seq, sample immediately, then every `intervalMs`. */
  start(): void {
    if (this._sharing) {
      return;
    }
    this._sharing = true;
    this.paused = false;
    this.seq = 0;
    this.arm();
  }

  /** End the share entirely (toggle off / thread-close / disarm). */
  stop(): void {
    this._sharing = false;
    this.paused = false;
    this.clearTimer();
  }

  /** Window blur: hold sampling but stay "sharing" so a refocus can resume it. */
  pause(): void {
    if (this._sharing && !this.paused) {
      this.paused = true;
      this.clearTimer();
    }
  }

  /** Window focus: continue sampling (same seq run) if the share is still on. */
  resume(): void {
    if (this._sharing && this.paused) {
      this.paused = false;
      this.arm();
    }
  }

  /** Release the interval on unmount (does not emit an off event — the caller owns that). */
  dispose(): void {
    this.clearTimer();
  }

  private arm(): void {
    this.clearTimer();
    void this.tick(); // an immediate first frame — don't make the model wait
    this.schedule();
  }

  /** A setTimeout CHAIN (not setInterval): the cadence thunk is re-read for
   * every gap, so the slider's change lands on the next frame. */
  private schedule(): void {
    this.timer = setTimeout(() => {
      void this.tick();
      if (this._sharing && !this.paused) {
        this.schedule();
      }
    }, this.currentInterval());
  }

  private currentInterval(): number {
    const raw =
      typeof this.deps.intervalMs === "function" ? this.deps.intervalMs() : this.deps.intervalMs;
    return raw !== undefined && raw > 0 ? raw : VIDEO_SAMPLE_INTERVAL_MS;
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private async tick(): Promise<void> {
    if (!this._sharing || this.paused || this.inFlight) {
      return;
    }
    this.inFlight = true;
    try {
      const bytes = await this.deps.captureFrame();
      // A capture can finish after a stop()/pause() (the async draw + encode) —
      // drop a frame the share no longer wants rather than stream it stale.
      if (bytes && this._sharing && !this.paused) {
        this.deps.sendFrame(this.seq++, bytes);
      }
    } finally {
      this.inFlight = false;
    }
  }
}
