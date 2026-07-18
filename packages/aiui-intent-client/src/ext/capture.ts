/**
 * capture.ts — the extension tier's pixels. **Salvaged, near-verbatim, from the
 * retired extension panel** (git history: aiui-extension/src/panel/capture.ts):
 * it is measured code, and the measurements are the reason it looks like this
 * (archive/extension-spikes/RESULTS.md M10).
 *
 * The service worker mints a `tabCapture` stream id — it alone can, that API
 * being privileged and invocation-gated — and THIS document consumes it with
 * `getUserMedia`. One context then owns the stream, the engine, the preview and
 * the wire, so a shot never crosses a process boundary and never becomes a
 * base64 string. The offscreen capture room the first design needed is gone.
 *
 * The latency budget it bought, on a 3840×1600 frame:
 *
 * | stage                             | before             | now                 |
 * |-----------------------------------|--------------------|---------------------|
 * | acquire (gUM + first frame)       | 148 ms PER SHOT    | once per turn       |
 * | encode                            | PNG 40 ms / 790 KB | JPEG 23 ms / 128 KB |
 * | transport                         | base64 through two `chrome.runtime` hops | none |
 *
 * (WebP was measured and rejected — Chrome's canvas WebP encoder takes 180 ms,
 * whatever its file size.)
 *
 * The stream is WARM: held for the turn's life by the `tabStream` claim, which
 * is why `holdStream` exists as a seam at all — the CDP tier has nothing to warm
 * (screenshots need no grant), but here the warmth IS the 36–48 ms shot.
 */

import type { PanelShot } from "../transport";

/** The tab whose stream is currently held (undefined = none). */
let heldTabId: number | undefined;
let stream: MediaStream | undefined;
let video: HTMLVideoElement | undefined;

/** Full-frame encode: fastest AND small (M10) — PNG was 2× slower and 6× bigger. */
const SHOT_MIME = "image/jpeg";
const SHOT_QUALITY = 0.85;

/** Is a stream currently held for this tab? */
export function streamHeldFor(tabId: number | undefined): boolean {
  return stream !== undefined && heldTabId !== undefined && heldTabId === tabId;
}

/**
 * How a captured tab sits inside a stream frame: Chrome aspect-FITS the tab
 * into the frame, CENTERED, black filling the rest (measured live 2026-07-17:
 * a 5120×1440 display-defaulted frame carried an 897×751-CSS tab as 1719×1440
 * centered at x≈1700). `scale` is stream px per CSS px; `offX`/`offY` are the
 * centering bars. An exactly tab-sized frame degenerates to scale = dpr,
 * offsets 0. Pure — exported for tests.
 */
export function letterboxFit(
  frame: { w: number; h: number },
  viewport: { w: number; h: number },
): { scale: number; offX: number; offY: number } {
  const scale = Math.min(frame.w / viewport.w, frame.h / viewport.h);
  return {
    scale,
    offX: (frame.w - viewport.w * scale) / 2,
    offY: (frame.h - viewport.h * scale) / 2,
  };
}

/**
 * The warm `tabCapture` MediaStream for `tabId`, or `undefined` (none held, or
 * held for another tab). This is the pencil host's video source in the MV3 tier
 * (pencil-host.ts) — the same stream the shot grabs off, shared, not a second
 * capture (a tab supports only one). Undefined outside a turn: the stream is
 * warmed by the tabStream claim, so remote video appears exactly when capture
 * does — which is the only time the iPad has anything to mark up.
 */
export function heldStreamFor(tabId: number | undefined): MediaStream | undefined {
  return streamHeldFor(tabId) ? stream : undefined;
}

/**
 * Hold a warm capture stream for `tabId`, consuming a stream id minted by the
 * service worker. Idempotent for the same tab; switching tabs releases the old
 * one first (a tab supports ONE active capture stream — measured, M1/M2).
 *
 * Throws the invocation-gate error verbatim when the tab was never invoked, so
 * the caller can recognize it and say the ⌘B remedy.
 */
export async function holdTabStream(
  tabId: number,
  mintStreamId: (tabId: number) => Promise<string>,
  /** The tab's device-pixel size (viewport × dpr). WITHOUT it the "tab" track
   * is NOT tab-sized: Chrome aspect-fits the tab into a display-sized frame,
   * centered, black filling the rest (measured live 2026-07-17 — a 5120×1440
   * ultrawide frame carried a 1719×1440 tab image at x≈1700; M1's claim that
   * the source alone picks tab pixels no longer holds). Passed as max
   * constraints so the stream IS the tab; grabTabShot's letterbox mapping
   * below is the belt for any residual mismatch. */
  size?: { width: number; height: number },
): Promise<void> {
  if (streamHeldFor(tabId)) {
    return;
  }
  releaseTabStream();
  const streamId = await mintStreamId(tabId);
  const media = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId,
        // max*, not min/max: the capture scales to FIT the box preserving
        // aspect, and the box matches the tab's aspect exactly, so the frame
        // comes out tab-sized. mins could overconstrain and throw.
        ...(size !== undefined ? { maxWidth: size.width, maxHeight: size.height } : {}),
      },
    } as MediaTrackConstraints,
  });
  const el = document.createElement("video");
  el.srcObject = media;
  el.muted = true;
  await el.play();
  await firstFrame(el);
  stream = media;
  video = el;
  heldTabId = tabId;
}

/** Release the held stream (turn end, tab switch, disarm, panel teardown). */
export function releaseTabStream(): void {
  for (const track of stream?.getTracks() ?? []) {
    track.stop();
  }
  video?.remove();
  stream = undefined;
  video = undefined;
  heldTabId = undefined;
}

/**
 * One frame off the warm stream: encoded bytes + a thumb. Pure draw + encode —
 * no acquisition, no messaging. Rejects when no stream is held.
 *
 * The thumb is FULL RESOLUTION by default (the shot methodology inherited from
 * the retired dev-overlay):
 * the same pixels as the upload, so the preview's hover peek shows real detail
 * rather than an upscaled 360-px blur. `thumbMaxPx` downscales it — the video
 * sampler passes a cap, because a full-res thumb riding EVERY sampled frame would
 * bloat the events and the trace; a manual/area shot is infrequent, so it pays
 * the full data URL for a crisp peek.
 */
export async function grabTabShot(opts?: {
  region?: {
    rect: { x: number; y: number; w: number; h: number };
    viewport: { w: number; h: number };
  };
  thumbMaxPx?: number;
}): Promise<PanelShot> {
  const region = opts?.region;
  const el = video;
  if (el === undefined || stream === undefined) {
    throw new Error("no capture stream held for this tab");
  }
  // CSS px → stream px, through the LETTERBOX. The frame should be tab-sized
  // (holdTabStream constrains it), but when it is not — an unconstrained hold,
  // a zoom/resize since acquisition — Chrome aspect-fits the tab into the
  // frame, CENTERED, black filling the rest (measured live, 2026-07-17). So:
  // scale by the smaller axis ratio, offset by the centering bars. With an
  // exactly tab-sized frame this is scale = dpr, offsets 0 — the old math.
  const fit =
    region !== undefined && region.viewport.w > 0 && region.viewport.h > 0
      ? letterboxFit({ w: el.videoWidth, h: el.videoHeight }, region.viewport)
      : { scale: 1, offX: 0, offY: 0 };
  const { scale: streamScale, offX, offY } = fit;
  const w =
    region !== undefined ? Math.max(1, Math.round(region.rect.w * streamScale)) : el.videoWidth;
  const h =
    region !== undefined ? Math.max(1, Math.round(region.rect.h * streamScale)) : el.videoHeight;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (ctx === null) {
    throw new Error("no 2d context for the shot canvas");
  }
  if (region !== undefined) {
    ctx.drawImage(
      el,
      Math.round(offX + region.rect.x * streamScale),
      Math.round(offY + region.rect.y * streamScale),
      w,
      h,
      0,
      0,
      w,
      h,
    );
  } else {
    ctx.drawImage(el, 0, 0);
  }

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, SHOT_MIME, SHOT_QUALITY),
  );
  if (blob === null) {
    throw new Error("the shot failed to encode");
  }
  const bytes = new Uint8Array(await blob.arrayBuffer());

  return {
    bytes,
    mime: SHOT_MIME,
    thumb: makeThumb(canvas, opts?.thumbMaxPx),
    width: w,
    height: h,
  };
}

/**
 * The inline preview's thumb, as a data URL, drawn from the SHOT canvas (never
 * the live `<video>` — so a region crop's thumb is the crop, not the whole frame
 * squished into it, the old bug). With no `maxPx` it is the full shot at capture
 * quality — the same detail as the upload, so the hover peek is crisp. `maxPx`
 * caps the longest edge (the video path) but never upscales.
 */
function makeThumb(canvas: HTMLCanvasElement, maxPx?: number): string {
  const longest = Math.max(canvas.width, canvas.height);
  if (maxPx === undefined || longest <= maxPx) {
    return canvas.toDataURL(SHOT_MIME, SHOT_QUALITY);
  }
  const scale = maxPx / longest;
  const thumbCanvas = document.createElement("canvas");
  thumbCanvas.width = Math.max(1, Math.round(canvas.width * scale));
  thumbCanvas.height = Math.max(1, Math.round(canvas.height * scale));
  thumbCanvas.getContext("2d")?.drawImage(canvas, 0, 0, thumbCanvas.width, thumbCanvas.height);
  return thumbCanvas.toDataURL("image/jpeg", 0.6);
}

/** Resolve once a frame has actually been PRESENTED — `play()` alone can race a
 * black first paint. Timeout-guarded, so a stalled stream degrades to whatever
 * pixels are there rather than hanging the turn. */
function firstFrame(el: HTMLVideoElement): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (): void => {
      if (!done) {
        done = true;
        resolve();
      }
    };
    if (typeof el.requestVideoFrameCallback === "function") {
      el.requestVideoFrameCallback(() => finish());
      setTimeout(finish, 1000);
    } else {
      setTimeout(finish, 250);
    }
  });
}
