/**
 * capture.ts — the extension tier's pixels. **Salvaged, near-verbatim, from the
 * old panel** (`aiui-extension/src/panel/capture.ts`): it is measured code, and
 * the measurements are the reason it looks like this (RESULTS.md M10).
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

/** Longest edge of the inline preview thumbnail, px. */
const THUMB_MAX_PX = 360;

/** Full-frame encode: fastest AND small (M10) — PNG was 2× slower and 6× bigger. */
const SHOT_MIME = "image/jpeg";
const SHOT_QUALITY = 0.85;

/** Is a stream currently held for this tab? */
export function streamHeldFor(tabId: number | undefined): boolean {
  return stream !== undefined && heldTabId !== undefined && heldTabId === tabId;
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
): Promise<void> {
  if (streamHeldFor(tabId)) {
    return;
  }
  releaseTabStream();
  const streamId = await mintStreamId(tabId);
  const media = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      // The tab's own pixels, not the display's: an unconstrained tab track
      // defaults to display-sized crop-and-scale (measured, M1).
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId,
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
 */
export async function grabTabShot(region?: {
  rect: { x: number; y: number; w: number; h: number };
  viewport: { w: number; h: number };
}): Promise<PanelShot> {
  const el = video;
  if (el === undefined || stream === undefined) {
    throw new Error("no capture stream held for this tab");
  }
  // The stream is in DEVICE pixels at the tab's captured size; the region
  // rect arrives in CSS pixels — the viewport width maps between them.
  const streamScale =
    region !== undefined && region.viewport.w > 0 ? el.videoWidth / region.viewport.w : 1;
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
      Math.round(region.rect.x * streamScale),
      Math.round(region.rect.y * streamScale),
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

  // The thumb rides the engine event (it is what the preview renders inline),
  // so it stays a data URL — it is small by construction.
  const scale = Math.min(1, THUMB_MAX_PX / Math.max(w, h));
  const thumbCanvas = document.createElement("canvas");
  thumbCanvas.width = Math.max(1, Math.round(w * scale));
  thumbCanvas.height = Math.max(1, Math.round(h * scale));
  thumbCanvas.getContext("2d")?.drawImage(el, 0, 0, thumbCanvas.width, thumbCanvas.height);

  return {
    bytes,
    mime: SHOT_MIME,
    thumb: thumbCanvas.toDataURL("image/jpeg", 0.6),
    width: w,
    height: h,
  };
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
