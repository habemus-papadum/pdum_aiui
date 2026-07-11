// The offscreen capture room (browser-extension proposal §1): consumes a
// tabCapture stream id via getUserMedia, grabs exactly ONE frame, and stops
// the stream immediately — a tab supports one active capture stream
// (measured, extension-spikes RESULTS.md), so holding it would block every
// other consumer of that tab.
//
// Static file on purpose: CRXJS only bundles manifest-referenced HTML pages,
// and an offscreen document is created at runtime by URL — a page under
// `public/` is the one artifact that ships verbatim in BOTH dist shapes (dev
// loader stubs and production build). Verbatim rules out workspace imports,
// so the envelope/result handling below mirrors the kit relay's wire shape
// (aiui-webext/src/relay.ts — change both together): request
// `{aiui:1, to:"offscreen", cmd:"grab", payload}`, response
// `{ok:true, value}` / `{ok:false, error}`.

/** Never leave the service worker awaiting a stalled stream. */
const GRAB_TIMEOUT_MS = 8000;

/** Longest edge of the inline preview thumbnail, px. */
const THUMB_MAX_PX = 360;

/**
 * One frame of the tab behind `streamId`, sized to the tab's own viewport.
 * `width`/`height` are the tab's CSS pixels, `dpr` its devicePixelRatio:
 * min=max constraints pin the track to the tab's native pixel size, because
 * an unconstrained tab track defaults to display-sized crop-and-scale output
 * (measured, RESULTS.md M1 — 5120x1440 for an 814-CSS-px page).
 */
async function grabFrame({ streamId, width, height, dpr }) {
  const w = Math.max(1, Math.round((width || 1280) * (dpr || 1)));
  const h = Math.max(1, Math.round((height || 800) * (dpr || 1)));
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId,
        minWidth: w,
        maxWidth: w,
        minHeight: h,
        maxHeight: h,
        maxFrameRate: 5,
      },
    },
  });
  try {
    const video = document.createElement("video");
    video.srcObject = stream;
    video.muted = true;
    await video.play();
    await firstFrame(video);
    const fw = video.videoWidth || w;
    const fh = video.videoHeight || h;
    const canvas = document.createElement("canvas");
    canvas.width = fw;
    canvas.height = fh;
    canvas.getContext("2d").drawImage(video, 0, 0);
    const png = canvas.toDataURL("image/png");
    const scale = Math.min(1, THUMB_MAX_PX / Math.max(fw, fh));
    const thumbCanvas = document.createElement("canvas");
    thumbCanvas.width = Math.max(1, Math.round(fw * scale));
    thumbCanvas.height = Math.max(1, Math.round(fh * scale));
    thumbCanvas.getContext("2d").drawImage(video, 0, 0, thumbCanvas.width, thumbCanvas.height);
    const thumb = thumbCanvas.toDataURL("image/jpeg", 0.6);
    return { png, thumb, width: fw, height: fh };
  } finally {
    for (const track of stream.getTracks()) {
      track.stop();
    }
  }
}

/** Resolve once a frame has actually been PRESENTED — play() alone can race a
 * black first paint. Timeout-guarded so a stalled stream degrades to whatever
 * pixels are there rather than hanging the shot. */
function firstFrame(video) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        resolve();
      }
    };
    if (typeof video.requestVideoFrameCallback === "function") {
      video.requestVideoFrameCallback(finish);
      setTimeout(finish, 1000);
    } else {
      setTimeout(finish, 250);
    }
  });
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => {
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    }),
  ]);
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (
    msg === null ||
    typeof msg !== "object" ||
    msg.aiui !== 1 ||
    msg.to !== "offscreen" ||
    typeof msg.cmd !== "string"
  ) {
    return false;
  }
  if (msg.cmd !== "grab") {
    sendResponse({ ok: false, error: `relay: unknown command "offscreen/${msg.cmd}"` });
    return false;
  }
  withTimeout(grabFrame(msg.payload ?? {}), GRAB_TIMEOUT_MS, "tab-capture grab")
    .then((value) => sendResponse({ ok: true, value }))
    .catch((error) =>
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }),
    );
  return true; // keep sendResponse alive for the async grab
});
