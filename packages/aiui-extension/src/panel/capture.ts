/**
 * The panel's capture hub — the media half of the §13.6 architecture
 * (decided + measured 2026-07-12, RESULTS.md M10).
 *
 * **The panel captures the tab itself.** The service worker mints a
 * `tabCapture` stream id (it alone can — that API is privileged and
 * invocation-gated), and THIS document consumes it with `getUserMedia`.
 * Measured: the side panel can (M10). Everything then happens in one context:
 * the panel already owns the engine, the preview and the channel socket, so a
 * shot never crosses a process boundary and never becomes a base64 string.
 *
 * What that replaced, and why (the latency budget, measured on a 3840×1600
 * frame):
 *
 * | stage                            | before            | now            |
 * |----------------------------------|-------------------|----------------|
 * | acquire stream (gUM + first frame)| 148 ms PER SHOT   | once per turn  |
 * | encode                            | PNG 40 ms / 790 KB| JPEG 23 ms / 128 KB |
 * | transport                         | base64 data URL through TWO `chrome.runtime` hops (JSON-serialized) | none — bytes go straight to the wire |
 *
 * The old path also needed an offscreen document (the only place a service
 * worker can touch media). It is gone: no offscreen doc, no relay, no
 * marshalling. WebP was measured too and rejected — Chrome's canvas WebP
 * encoder is *slow* (180 ms), whatever its file size.
 *
 * The stream is WARM: held while a turn is open on that tab, released on turn
 * end / tab switch / disarm (the panel's `syncTabStream`). A shot is then just
 * a `drawImage` + an encode.
 */

/** The tab whose stream is currently held (undefined = none). */
let heldTabId: number | undefined;
let stream: MediaStream | undefined;
let video: HTMLVideoElement | undefined;

/** Longest edge of the inline preview thumbnail, px. */
const THUMB_MAX_PX = 360;

/** Full-frame encode: fastest AND small (M10) — PNG was 2× slower and 6× bigger. */
const SHOT_MIME = "image/jpeg";
const SHOT_QUALITY = 0.85;

export interface Shot {
  /** Raw encoded bytes — straight to the wire, never base64. */
  bytes: Uint8Array;
  /** The image's mime (the attachment chunk carries it). */
  mime: string;
  /** A small data-URL thumb for the transcript preview's inline chip. */
  thumb: string;
  width: number;
  height: number;
  /** Per-stage timings (debug logging). */
  timing: Record<string, number>;
}

/** Is a stream currently held for this tab? */
export function streamHeldFor(tabId: number | undefined): boolean {
  return stream !== undefined && heldTabId !== undefined && heldTabId === tabId;
}

/**
 * Hold a warm capture stream for `tabId`, consuming a stream id minted by the
 * service worker. Idempotent for the same tab; switching tabs releases the old
 * one first (a tab supports ONE active capture stream — measured M1/M2).
 *
 * Throws the invocation-gate error verbatim when the tab was never invoked, so
 * the caller can recognize it (`isNotInvokedError`) and say the ⌘B remedy.
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
export async function grabShot(): Promise<Shot> {
  const el = video;
  if (el === undefined || stream === undefined) {
    throw new Error("no capture stream held for this tab");
  }
  const t0 = performance.now();
  const w = el.videoWidth;
  const h = el.videoHeight;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (ctx === null) {
    throw new Error("no 2d context for the shot canvas");
  }
  ctx.drawImage(el, 0, 0);
  const tDraw = performance.now();

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, SHOT_MIME, SHOT_QUALITY),
  );
  if (blob === null) {
    throw new Error("the shot failed to encode");
  }
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const tEncode = performance.now();

  // The thumb rides the engine event (it is what the preview renders inline),
  // so it stays a data URL — it is small by construction.
  const scale = Math.min(1, THUMB_MAX_PX / Math.max(w, h));
  const thumbCanvas = document.createElement("canvas");
  thumbCanvas.width = Math.max(1, Math.round(w * scale));
  thumbCanvas.height = Math.max(1, Math.round(h * scale));
  thumbCanvas.getContext("2d")?.drawImage(el, 0, 0, thumbCanvas.width, thumbCanvas.height);
  const thumb = thumbCanvas.toDataURL("image/jpeg", 0.6);
  const tThumb = performance.now();

  return {
    bytes,
    mime: SHOT_MIME,
    thumb,
    width: w,
    height: h,
    timing: {
      draw: Math.round(tDraw - t0),
      encode: Math.round(tEncode - tDraw),
      thumb: Math.round(tThumb - tEncode),
      kb: Math.round(bytes.length / 1024),
    },
  };
}

/** Resolve once a frame has actually been PRESENTED — `play()` alone can race
 * a black first paint. Timeout-guarded so a stalled stream degrades to
 * whatever pixels are there rather than hanging the turn. */
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
