/**
 * The multimodal modality's **capture owners** — framework-free plumbing
 * extracted from modality.ts (proposal B2.4), which composes it and remains
 * the only caller.
 *
 * Owns the {@link ShotTool} (region/viewport shots with the component
 * locator, compositing the ink layer's strokes), the transient `shooting`
 * flag (D held / drag in flight — the flag `uiMode` reads), and the screen
 * share's {@link VideoSampler} lifecycle riding the SAME display-capture grant
 * the shots use. The share's bounded-by-turn invariant is enforced by the
 * reconciler surface, which stays in modality.ts and reads through this module
 * ({@link Capture.sharing} / {@link Capture.stopShare}).
 *
 * **A share frame is a shot.** Every sampled frame goes down the same road as
 * an S press: a `shot` event with the viewport rect, a JPEG uploaded under that
 * shot's marker. Which means it lands in the transcript where it was taken, the
 * compiler inlines it into the prompt, and both linters see it — with no second
 * transport, no second consumer, and no second rendering. The only thing marking
 * it as a frame rather than a keypress is the `share` term on the event
 * (`ShotShare`: ordinal, mode, offset from the share's first frame).
 *
 * Talks to the engine, the wire's upload helpers, and the host context only
 * through {@link CaptureDeps}.
 */

import type { OverlayErrorInput } from "../../errors";
import type { Engine, Rect, VideoCaptureMode } from "../../intent-pipeline";
import { createDisplayCapture, type DisplayCapture } from "../display-capture";
import type { Ink } from "../ink";
import { canvasJpegBytes, type ShotPixels, ShotTool } from "../shot";
import {
  sampleDimensions,
  VIDEO_FRAME_MIME,
  VIDEO_JPEG_QUALITY,
  VIDEO_SAMPLE_INTERVAL_MS,
  VideoSampler,
} from "../video";

/** What the capture owners need from their composer (modality.ts). */
export interface CaptureDeps {
  engine: Engine;
  /** The ink layer — the ShotTool freezes its strokes into captured pixels. */
  ink: Ink;
  /** wire.uploadAttachment — a shot's image bytes, correlated by its marker. */
  uploadAttachment: (id: string, mime: string, bytes: Uint8Array) => Promise<void>;
  /** `ctx.setStatus` — the panel-footer status line. */
  setStatus: (text: string) => void;
  /** `ctx.reportError` — the dismissible, deduping toast. */
  reportError: (error: OverlayErrorInput) => void;
  /** Re-render the HUD (a hoisted declaration in the composer). */
  renderHud: () => void;
  /**
   * The sampler's cadence in ms; defaults to the sampler's ~1 fps. Injected
   * only by tests, which shorten it so a couple of sampled frames flow within
   * a `wait()`.
   */
  videoSampleIntervalMs?: number;
  /**
   * Live cadence from the effective config (`videoFrameIntervalMs`) — read
   * before every tick, so the share's fps slider applies immediately. The
   * test seam above wins when present.
   */
  videoFrameIntervalMs?: () => number;
  /**
   * Live capture mode from the effective config (`videoMode`) — read before
   * every tick, so the HUD's 🦉/🔫 toggle applies to the next frame. Defaults
   * to smart.
   */
  videoMode?: () => VideoCaptureMode;
  /**
   * Smart mode's gate: has the user touched the app since the last frame?
   * Reads *and clears* (the interaction monitor's `consume()`). Absent — in
   * tests that don't care — means "always", i.e. smart degrades to continuous.
   */
  interacted?: () => boolean;
  /**
   * Re-arm smart mode's gate (the interaction monitor's `note()`), for a tick
   * that consumed {@link interacted} and then failed to deliver a frame. See
   * `VideoSamplerDeps.rearm`.
   */
  noteInteraction?: () => void;
  /**
   * The document's display-capture broker. Injected by tests (jsdom has no
   * `getDisplayMedia`); otherwise created here and published on
   * `window.__AIUI__.displayCapture` by the composer, so the paint host streams
   * the iPad's video from the same grant.
   */
  displayCapture?: DisplayCapture;
}

/** The capture surface modality.ts (dispatch, reconciler, HUD, report) drives. */
export interface Capture {
  /** The shot veil element — the composer appends it to the page layers. */
  veil: HTMLElement;
  /** The document's one display-capture grant (published on the page seam). */
  grant: DisplayCapture;
  /**
   * Armed and the browser auto-accepts capture: take the grant now, so the
   * first shot is instant and its blur lands at arm rather than mid-gesture.
   * A no-op under the `"gesture"` policy — a picker nobody asked for.
   */
  prewarmGrant(): void;
  /**
   * True while a `getDisplayMedia` call's own blur/focus pair is arriving.
   * EVERY capture call blurs the window, dialog or no dialog, and the blur
   * handler must not mistake that for the user leaving (it stops the mic).
   */
  blurIsSelfInflicted(): boolean;
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
  const { engine, ink, uploadAttachment, setStatus, reportError, renderHud } = deps;
  const videoMode = (): VideoCaptureMode => deps.videoMode?.() ?? "smart";

  const grant = deps.displayCapture ?? createDisplayCapture();
  const shots = new ShotTool(
    ink,
    (rect, components, viewport, thumb, bytes, takenAt) => {
      // A capture can resolve long after the gesture — a cold shot blocks on
      // the getDisplayMedia picker — by which time the turn may have been sent
      // or cancelled (send disarms). A disarmed engine means this shot has no
      // turn to join: drop it, or the straggler event lands after the preview
      // cleared and its thumb haunts the next arm.
      if (!engine.armed) {
        return;
      }
      // No dev-proxy: the channel assigns the on-disk path from the uploaded
      // bytes, so the shot event carries no path — its marker correlates it
      // with the attachment frame. `takenAt` (the gesture's wall-clock) rides
      // the event so the compiler can anchor the shot into the transcript.
      const marker = engine.shotDone(rect, components, thumb, undefined, viewport, takenAt);
      if (bytes) {
        void uploadAttachment(marker, "image/png", bytes);
      }
    },
    grant,
  );

  // ── the screen share's frame sampler (V) ─────────────────────────────────
  // While sharing, sample the SAME display-capture stream the shots grab from
  // — one grant serves both — and land each frame as a first-class viewport
  // SHOT: a `shot` event carrying its `share` terms, bytes uploaded under the
  // shot's marker. From there the existing machinery does everything — the
  // preview thumb, the transcript anchor, the compile into the prompt, the
  // linter injection. `videoShareOrdinal` bumps per toggle-on; the sampler
  // counts `seq`/offset within one share. `captureVideoFrame` is a hoisted
  // declaration below.
  let videoShareOrdinal = 0;
  const cadenceMs = (): number =>
    deps.videoSampleIntervalMs ?? deps.videoFrameIntervalMs?.() ?? VIDEO_SAMPLE_INTERVAL_MS;
  const videoSampler = new VideoSampler<ShotPixels>({
    captureFrame: () => captureVideoFrame(),
    sendFrame: (frame, pixels) => {
      // Same guard as the ShotTool's sink (which this path bypasses): a frame
      // resolving after send/cancel has no turn to join — drop it, or its
      // event lands after the preview cleared.
      if (!engine.armed) {
        return;
      }
      const rect: Rect = { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight };
      // No locator, like the S key's viewport shot: "the whole screen" frames
      // everything, so element metadata adds bulk without a reference point.
      const marker = engine.shotDone(rect, [], pixels.thumb, undefined, true, frame.takenAt, {
        ordinal: videoShareOrdinal,
        // Stamped per frame, not per share: the mode toggle applies live, and
        // each frame should say what actually produced it.
        mode: videoMode(),
        offsetMs: frame.offsetMs,
      });
      void uploadAttachment(marker, VIDEO_FRAME_MIME, pixels.bytes);
    },
    intervalMs: cadenceMs,
    // Smart mode's gate: only capture if the user touched the app since the
    // last frame. Short-circuit ORDER matters — `interacted()` consumes the
    // monitor's flag, and continuous mode must not eat an interaction that
    // smart mode would owe a frame for after a live mode flip.
    shouldCapture: () => videoMode() === "continuous" || (deps.interacted?.() ?? true),
    // A tick that ate the interaction and produced no frame has to give it
    // back. Only smart mode has a debt: continuous short-circuits above and
    // never reads (never clears) the monitor.
    rearm: () => {
      if (videoMode() !== "continuous") {
        deps.noteInteraction?.();
      }
    },
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
    // The ordinal is consumed even if the grant is denied below — ordinals
    // only need to be unique, and the trace's on→off pair explains the gap.
    videoShareOrdinal += 1;
    engine.videoShare(true, {
      ordinal: videoShareOrdinal,
      mode: videoMode(),
      cadenceMs: cadenceMs(),
    });
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
    videoSampler.start();
    renderHud();
  }

  /** Draw the shared capture element to a downscaled JPEG frame (bytes for the
   * upload, a data-URL thumb for the preview row), or undefined. */
  async function captureVideoFrame(): Promise<ShotPixels | undefined> {
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
    const bytes = await canvasJpegBytes(canvas, VIDEO_JPEG_QUALITY);
    if (!bytes) {
      return undefined;
    }
    return { thumb: canvas.toDataURL("image/jpeg", VIDEO_JPEG_QUALITY), bytes };
  }

  return {
    veil: shots.veil,
    grant,
    prewarmGrant: () => grant.prewarm(),
    blurIsSelfInflicted: () => grant.blurIsSelfInflicted(),
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
      // The one place the grant ends: it outlives every individual consumer
      // (the paint host streams from it too), but not the page.
      grant.dispose();
    },
  };
}

// HMR guard: the mounted intent tool holds RUNNING closures from this module,
// and a hot swap would strand them on stale code while fresh modules load
// around them (the silent-stale-tab footgun: pushes flow, the view ignores
// them). Declining makes any edit here a full page reload — mount-once code
// has no meaningful hot path.
if (import.meta.hot) {
  import.meta.hot.accept(() => {
    // decline() is a NO-OP in Vite 5+ — invalidate-on-accept is the working
    // way to say "this module has no hot path": the update re-propagates as
    // if unaccepted and lands as a full page reload.
    import.meta.hot?.invalidate();
  });
}
