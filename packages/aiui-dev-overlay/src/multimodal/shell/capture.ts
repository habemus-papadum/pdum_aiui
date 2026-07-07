/**
 * The multimodal modality's **capture owners** — framework-free plumbing
 * extracted from modality.ts (proposal B2.4), which composes it and remains
 * the only caller.
 *
 * Owns the {@link ShotTool} (region/viewport shots with the component
 * locator, compositing the ink layer's strokes), the transient `shooting`
 * flag (D held / drag in flight — the flag `uiMode` reads), and the realtime
 * submode's {@link VideoSampler} share lifecycle riding the SAME
 * display-capture grant the shots use. The share's bounded-by-turn invariant
 * is enforced by the reconciler surface, which stays in modality.ts and reads
 * through this module ({@link Capture.sharing} / {@link Capture.stopShare}).
 *
 * Talks to the engine, the wire's upload helpers, and the host context only
 * through {@link CaptureDeps}.
 */

import type { OverlayErrorInput } from "../../errors";
import type { Engine } from "../../intent-pipeline";
import type { Ink } from "../ink";
import { canvasJpegBytes, ShotTool } from "../shot";
import { sampleDimensions, VIDEO_JPEG_QUALITY, VideoSampler } from "../video";

/** What the capture owners need from their composer (modality.ts). */
export interface CaptureDeps {
  engine: Engine;
  /** The ink layer — the ShotTool freezes its strokes into captured pixels. */
  ink: Ink;
  /** wire.uploadAttachment — a shot's PNG bytes, correlated by its marker. */
  uploadAttachment: (id: string, mime: string, bytes: Uint8Array) => Promise<void>;
  /** wire.uploadVideo — one sampled share frame (`vid_<share>`), in seq order. */
  uploadVideo: (share: number, seq: number, bytes: Uint8Array) => Promise<void>;
  /** `ctx.setStatus` — the panel-footer status line. */
  setStatus: (text: string) => void;
  /** `ctx.reportError` — the dismissible, deduping toast. */
  reportError: (error: OverlayErrorInput) => void;
  /** Re-render the HUD (a hoisted declaration in the composer). */
  renderHud: () => void;
  /**
   * The realtime video sampler's cadence in ms; defaults to the sampler's
   * ~1 fps. Injected only by tests, which shorten it so a couple of sampled
   * frames flow within a `wait()`.
   */
  videoSampleIntervalMs?: number;
}

/** The capture surface modality.ts (dispatch, reconciler, HUD, report) drives. */
export interface Capture {
  /** The shot veil element — the composer appends it to the page layers. */
  veil: HTMLElement;
  /** The shot veil is armed (D held / drag in flight) — feeds `uiMode`. */
  shooting(): boolean;
  /** D pressed: arm the crosshair veil (ink mode only). */
  armShot(): void;
  /** D released: always disarm (keys off `shooting`, never the mode). */
  releaseShot(): void;
  /** Drop the veil unconditionally (window blur, the stranded-veil guard). */
  cancelShot(): void;
  /** S: capture the whole viewport now (ink mode only). */
  shootViewport(): void;
  /** True while a screen share is active — feeds the HUD badge + the guard. */
  sharing(): boolean;
  /** End the share's sampling (the bounded-by-turn reconciler surface). */
  stopShare(): void;
  /** Window blur: hold sampling without ending the share. */
  pauseShare(): void;
  /** Window focus: continue sampling if the share is still on. */
  resumeShare(): void;
  /** V: toggle the realtime submode's ~1 fps screen share. */
  toggleVideoShare(): Promise<void>;
  /** Whether a display-capture grant is live (for the overlay's report). */
  hasCaptureGrant(): boolean;
  /** Unmount: release the sampler interval and the shot tool. */
  dispose(): void;
}

export function createCapture(deps: CaptureDeps): Capture {
  const { engine, ink, uploadAttachment, uploadVideo, setStatus, reportError, renderHud } = deps;

  const shots = new ShotTool(ink, (rect, components, viewport, thumb, bytes) => {
    // A capture can resolve long after the gesture — the first shot blocks
    // on the getDisplayMedia picker — by which time the turn may have been
    // sent or cancelled (send disarms). A disarmed engine means this shot
    // has no turn to join: drop it, or the straggler event lands after the
    // preview cleared and its thumb haunts the next arm.
    if (!engine.armed) {
      return;
    }
    // No dev-proxy: the channel assigns the on-disk path from the uploaded
    // bytes, so the shot event carries no path — its marker correlates it
    // with the attachment frame.
    const marker = engine.shotDone(rect, components, thumb, undefined, viewport);
    if (bytes) {
      void uploadAttachment(marker, "image/png", bytes);
    }
  });

  // ── the realtime submode's screen sampler (V) ────────────────────────────
  // While sharing (a live tier only), sample the SAME display-capture stream
  // the shots grab from — one grant serves both — at ~1 fps into `video`
  // chunks: unlabeled ambient context for the live model (deliberate shots
  // stay the referenceable artifacts). `videoShareOrdinal` bumps per
  // toggle-on (`vid_N`); the sampler counts the frame `seq` within one share.
  // `captureVideoFrame` is a hoisted declaration below.
  let videoShareOrdinal = 0;
  const videoSampler = new VideoSampler({
    captureFrame: () => captureVideoFrame(),
    sendFrame: (seq, bytes) => void uploadVideo(videoShareOrdinal, seq, bytes),
    ...(deps.videoSampleIntervalMs !== undefined ? { intervalMs: deps.videoSampleIntervalMs } : {}),
  });

  let shooting = false;

  // D pressed: arm the crosshair veil so the next drag is a region
  // shot. Only in ink mode — correct mode owns the pointer for text
  // selection, and shots belong to the ink layer.
  const armShot = (): void => {
    if (engine.mode === "ink") {
      shooting = true;
      shots.setArmed(true);
    }
  };

  // D released: always disarm — this clears the veil even if the mode
  // flipped mid-hold (shoot-release keys off `shooting`, never the
  // mode, so the veil can't be stranded). setArmed(false) defers the
  // actual hide when a drag is still in flight so its pointerup can
  // finish the capture. There is deliberately NO viewport fallback
  // here: the whole-viewport shot is S's own key, split off so a fast
  // drag (pointerup before this keyup) can't also fire it.
  const releaseShot = (): void => {
    if (shooting) {
      shooting = false;
      shots.setArmed(false);
    }
  };

  const cancelShot = (): void => {
    shots.setArmed(false);
    shooting = false;
  };

  // S: capture the whole viewport now — a single press, no veil, no
  // hold. Gated on ink mode like the region shot.
  const shootViewport = (): void => {
    if (engine.mode === "ink") {
      void shots.shootViewport();
    }
  };

  /**
   * Toggle screen sharing. Only reached in the realtime submode (the dispatch
   * gates on it). Turning ON marks the share (which opens the thread + shows
   * the badge) *then* acquires the display-capture grant — the same one-time
   * picker a shot uses, auto-accepted in the session browser — so the thread
   * is already open when the sampler's immediate first frame lands. A denied
   * grant retracts the share honestly (badge off, an on→off in the trace)
   * rather than sampling blind.
   */
  async function toggleVideoShare(): Promise<void> {
    if (videoSampler.sharing) {
      videoSampler.stop();
      engine.videoShare(false);
      renderHud();
      return;
    }
    engine.videoShare(true);
    renderHud();
    const video = await shots.ensureCaptureStream();
    if (!engine.armed) {
      return; // disarmed during the picker — disarm already tore it all down
    }
    if (!video) {
      engine.videoShare(false);
      const message = "screen capture unavailable — video sharing needs a display-capture grant";
      setStatus(message);
      reportError({ source: "capture", message });
      renderHud();
      return;
    }
    videoShareOrdinal += 1;
    videoSampler.start();
    renderHud();
  }

  /** Draw the shared capture element to a downscaled JPEG frame, or undefined. */
  async function captureVideoFrame(): Promise<Uint8Array | undefined> {
    const video = await shots.ensureCaptureStream();
    if (!video) {
      return undefined; // grant lost mid-share — skip this frame
    }
    const { width, height } = sampleDimensions(video.videoWidth, video.videoHeight);
    const canvas = document.createElement("canvas");
    // Clamp to ≥1: a not-yet-ready element (videoWidth 0) yields a tiny frame
    // rather than a zero-dimension canvas — rare, since ensureStream awaits play().
    canvas.width = Math.max(1, width);
    canvas.height = Math.max(1, height);
    const c2d = canvas.getContext("2d");
    if (!c2d) {
      return undefined;
    }
    c2d.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvasJpegBytes(canvas, VIDEO_JPEG_QUALITY);
  }

  return {
    veil: shots.veil,
    shooting: () => shooting,
    armShot,
    releaseShot,
    cancelShot,
    shootViewport,
    sharing: () => videoSampler.sharing,
    stopShare: () => videoSampler.stop(),
    pauseShare: () => videoSampler.pause(),
    resumeShare: () => videoSampler.resume(),
    toggleVideoShare,
    hasCaptureGrant: () => shots.hasCaptureGrant(),
    dispose: () => {
      videoSampler.dispose();
      shots.dispose();
    },
  };
}
