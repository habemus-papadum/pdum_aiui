/**
 * The screen share's frame sampler (V).
 *
 * While the user is sharing, the modality draws the display-capture stream to a
 * canvas on a cadence, encodes a downscaled JPEG, and hands it back as an
 * ordinary **shot** — the same artifact the S key produces, only taken by the
 * clock instead of by a keypress. So a share is not a second kind of context: it
 * is a stream of screenshots that the linters see and the compiler inlines into
 * the prompt at the moment they were taken.
 *
 * Two cadence modes (`VideoCaptureMode`), both riding this one machine:
 *
 *  - **smart** (the default, 🦉): a tick captures only if the user has touched
 *    the app since the last frame — `shouldCapture` is the interaction monitor's
 *    `consume()`. A still screen sends nothing, so leaving the share on while
 *    you think costs nothing.
 *  - **continuous** (🔫): every tick captures, cadence or bust. For narrating
 *    an animation, a drag, anything that moves on its own.
 *
 * The first frame of a share always fires, gate or no gate — turning the share
 * on IS an interaction, and it's the frame that says what the screen looked like
 * when you started talking.
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

/** One frame's identity within its share, as {@link VideoSamplerDeps.sendFrame} sees it. */
export interface SampledFrame {
  /** The frame's index within this share, counting from 0. Skipped ticks don't advance it. */
  seq: number;
  /** Wall-clock at which the pixels were grabbed — before the encode, which is async. */
  takenAt: number;
  /** `takenAt` minus the share's start — what the prompt renders as `at="N.Ns"`. */
  offsetMs: number;
}

/**
 * The pixel + delivery seams the {@link VideoSampler} drives. Generic in the
 * captured payload `T` because the machine never looks inside one — it only
 * asks "did a frame come back?". The modality passes `ShotPixels` (thumb + JPEG
 * bytes); the tests pass whatever is convenient.
 */
export interface VideoSamplerDeps<T = Uint8Array> {
  /**
   * Capture one downscaled JPEG frame of the shared screen, or `undefined` when
   * the capture surface isn't available right now (grant denied/ended). Async:
   * the first call may acquire the one-time display-capture grant.
   */
  captureFrame(): Promise<T | undefined>;
  /** Deliver one captured frame. */
  sendFrame(frame: SampledFrame, pixels: T): void;
  /**
   * Sampling cadence in ms — a number, or a THUNK read before each tick so a
   * live config change (the share's fps slider) takes effect on the very
   * next frame without restarting the share. Defaults to
   * {@link VIDEO_SAMPLE_INTERVAL_MS}.
   */
  intervalMs?: number | (() => number);
  /**
   * Smart mode's gate, consulted **once per tick** (the first frame of a share
   * excepted, which always fires): capture this frame? The modality passes the
   * interaction monitor's `consume()`, which reads *and clears* the "the user
   * touched something" flag — so it must be called exactly once per tick, and
   * only for ticks that actually get to decide. Omit for continuous mode.
   *
   * A tick the gate declines is not a frame: `seq` doesn't advance and nothing
   * reaches `sendFrame`, so a share sitting over a still screen is free.
   */
  shouldCapture?(): boolean;
  /** Clock seam (`Date.now`). */
  now?(): number;
}

/**
 * The share cadence + toggle/pause state machine. One share is a `start()` …
 * `stop()` span, during which frames arrive at the interval with a `seq`
 * counting from 0 (a new share resets it — the modality bumps the share
 * ordinal in parallel). `pause()`/`resume()` (window blur/focus) hold and
 * continue sampling *without* ending the share, so a glance away doesn't drop
 * the context and refocus picks it right back up.
 *
 * Smart mode adds one rule on top: {@link VideoSamplerDeps.shouldCapture} vetoes
 * a tick, and a vetoed tick is a non-event — no `seq`, no `sendFrame`, nothing
 * in the transcript. The share's very first frame is exempt.
 */
export class VideoSampler<T = Uint8Array> {
  private readonly deps: VideoSamplerDeps<T>;
  private _sharing = false;
  private paused = false;
  private seq = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** Guards against overlapping ticks when a `captureFrame` outlives its interval. */
  private inFlight = false;
  /** Wall-clock of `start()` — the origin every frame's `offsetMs` is measured from. */
  private startedAt = 0;
  /** The next tick bypasses `shouldCapture` (set by `start()`; see the class doc). */
  private forceNext = false;

  constructor(deps: VideoSamplerDeps<T>) {
    this.deps = deps;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
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
    this.startedAt = this.now();
    this.forceNext = true;
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
      // Not a decision, so don't consume the gate: whatever the user touched
      // while we were busy is still unphotographed, and the next tick owes
      // them a frame for it.
      return;
    }
    // Consume unconditionally, even on the forced first frame — otherwise a
    // click made just before V would arm the second tick as well.
    const changed = this.deps.shouldCapture?.() ?? true;
    const forced = this.forceNext;
    this.forceNext = false;
    if (!forced && !changed) {
      return;
    }
    this.inFlight = true;
    try {
      const takenAt = this.now();
      const pixels = await this.deps.captureFrame();
      // A capture can finish after a stop()/pause() (the async draw + encode) —
      // drop a frame the share no longer wants rather than stream it stale.
      if (pixels !== undefined && this._sharing && !this.paused) {
        this.deps.sendFrame(
          { seq: this.seq++, takenAt, offsetMs: Math.max(0, takenAt - this.startedAt) },
          pixels,
        );
      }
    } finally {
      this.inFlight = false;
    }
  }
}
