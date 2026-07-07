/**
 * Standalone paint-stream demo — no overlay, no channel server, nothing else.
 *
 * A large scrollable "document" (grid + landmark blocks so scrolling is visibly
 * doing something) with an {@link InkSurface} sized to the whole document. You
 * can draw on it directly with the mouse, and — because the page also runs a
 * paint {@link startPaintHost} — draw on it from an iPad over the relay. The
 * iPad's normalized coordinates are viewport-relative; a small custom sink adds
 * the current scroll offset so remote ink lands in document space, exactly where
 * a local stroke would.
 *
 * Video: rather than `getDisplayMedia` (which needs a user gesture and a secure
 * context, and pops a share-picker), the demo renders its OWN viewport — grid +
 * landmarks + the visible slice of the ink — into a canvas and streams that via
 * `canvas.captureStream()`. That works with no prompt, from any origin, and
 * feeds both the JPEG and WebRTC transports through the same {@link FrameSource}.
 *
 * Launched by `demo/serve.ts` (`pnpm paint:demo`), which starts the relay and
 * this Vite app together and injects the relay port below.
 */
import {
  type FrameSource,
  type InkSink,
  InkSurface,
  type PaintHost,
  type SinkPoint,
  type SinkStyle,
  startPaintHost,
} from "@habemus-papadum/aiui-paint";

/** Injected by `serve.ts` via Vite `define`. */
declare const __RELAY_PORT__: number;

const DOC_W = 2400;
const DOC_H = 3000;
const PALETTE = ["#ff5c87", "#ffd166", "#06d6a0", "#4cc9f0", "#b5179e", "#ffffff"];
const WIDTHS = [2, 4, 8, 16];
/** Longest edge of a streamed frame — caps bandwidth on big monitors. */
const MAX_STREAM_EDGE = 1440;

// Background colors mirror the CSS in index.html so the streamed frame matches
// what the desktop shows.
const BG = "#10131b";
const GRID_MINOR = { step: 40, color: "#151b28" };
const GRID_MAJOR = { step: 200, color: "#1b2230" };
const LANDMARK_W = 300;
const LANDMARK_H = 180;

const state = { color: PALETTE[0], width: WIDTHS[1] };

const doc = document.getElementById("doc") as HTMLDivElement;
const statusEl = document.getElementById("status") as HTMLSpanElement;
const hintEl = document.getElementById("hint") as HTMLDivElement;
doc.style.width = `${DOC_W}px`;
doc.style.height = `${DOC_H}px`;

// ── landmarks: labeled blocks scattered across the document ───────────────────
const LANDMARKS = [
  { x: 40, y: 40, label: "TOP-LEFT (0, 0)", color: "#26324a" },
  { x: DOC_W - 340, y: 40, label: "TOP-RIGHT", color: "#3a2a4a" },
  { x: DOC_W / 2 - 150, y: DOC_H / 2 - 90, label: "CENTER", color: "#123a34" },
  { x: 40, y: DOC_H - 220, label: "BOTTOM-LEFT", color: "#4a3320" },
  { x: DOC_W - 340, y: DOC_H - 220, label: "BOTTOM-RIGHT", color: "#402030" },
  { x: DOC_W / 2 - 150, y: 60, label: "scroll down ↓", color: "#1d2b4a" },
  { x: 60, y: DOC_H / 2 - 90, label: "scroll around ↔", color: "#2b1d4a" },
];
for (const m of LANDMARKS) {
  const el = document.createElement("div");
  el.className = "landmark";
  el.textContent = m.label;
  Object.assign(el.style, {
    left: `${m.x}px`,
    top: `${m.y}px`,
    width: `${LANDMARK_W}px`,
    height: `${LANDMARK_H}px`,
    background: m.color,
    color: "#e8ebf0",
    fontSize: "20px",
  });
  doc.append(el);
}

// ── the ink surface, sized to the whole document ─────────────────────────────
const surface = new InkSurface({
  target: doc,
  color: () => state.color,
  width: () => state.width,
  fadeSec: () => 0, // persist — this is a drawing, not a gesture annotation
});
// Reposition/resize the surface to fill the document (it defaults to a fixed,
// viewport-sized overlay). Then re-run its resize so the backing store matches.
Object.assign(surface.canvas.style, {
  position: "absolute",
  left: "0",
  top: "0",
  width: `${DOC_W}px`,
  height: `${DOC_H}px`,
  zIndex: "1",
});
window.dispatchEvent(new Event("resize"));
surface.setActive(true); // capture the mouse for local drawing

// ── the streamed frame: our own render of the current viewport ────────────────
const streamCanvas = document.createElement("canvas");
const streamCtx = streamCanvas.getContext("2d");

function drawGrid(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  ox: number,
  oy: number,
  step: number,
  color: string,
): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = -(((ox % step) + step) % step); x <= w; x += step) {
    const px = Math.round(x) + 0.5;
    ctx.moveTo(px, 0);
    ctx.lineTo(px, h);
  }
  for (let y = -(((oy % step) + step) % step); y <= h; y += step) {
    const py = Math.round(y) + 0.5;
    ctx.moveTo(0, py);
    ctx.lineTo(w, py);
  }
  ctx.stroke();
}

/** Render the viewport (background + landmarks + ink) into the stream canvas. */
function drawStreamFrame(): void {
  const ctx = streamCtx;
  if (!ctx) {
    return;
  }
  const vw = Math.max(1, window.innerWidth);
  const vh = Math.max(1, window.innerHeight);
  const scale = Math.min(1, MAX_STREAM_EDGE / Math.max(vw, vh));
  const cw = Math.round(vw * scale);
  const ch = Math.round(vh * scale);
  if (streamCanvas.width !== cw) {
    streamCanvas.width = cw;
  }
  if (streamCanvas.height !== ch) {
    streamCanvas.height = ch;
  }
  const ox = window.scrollX;
  const oy = window.scrollY;

  ctx.setTransform(scale, 0, 0, scale, 0, 0); // draw in CSS px; the canvas is downscaled
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, vw, vh);
  drawGrid(ctx, vw, vh, ox, oy, GRID_MINOR.step, GRID_MINOR.color);
  drawGrid(ctx, vw, vh, ox, oy, GRID_MAJOR.step, GRID_MAJOR.color);

  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = "700 20px -apple-system, system-ui, sans-serif";
  for (const m of LANDMARKS) {
    const x = m.x - ox;
    const y = m.y - oy;
    if (x > vw || y > vh || x + LANDMARK_W < 0 || y + LANDMARK_H < 0) {
      continue;
    }
    ctx.fillStyle = m.color;
    ctx.beginPath();
    ctx.roundRect(x, y, LANDMARK_W, LANDMARK_H, 16);
    ctx.fill();
    ctx.fillStyle = "#e8ebf0";
    ctx.fillText(m.label, x + LANDMARK_W / 2, y + LANDMARK_H / 2);
  }

  // Ink lives in document coords; subtract scroll to place it in the viewport.
  surface.compositeInto(ctx, ox, oy, 1);
}

function canvasToJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Uint8Array | undefined> {
  return new Promise((resolve) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          resolve(undefined);
          return;
        }
        blob
          .arrayBuffer()
          .then((buf) => resolve(new Uint8Array(buf)))
          .catch(() => resolve(undefined));
      },
      "image/jpeg",
      quality,
    );
  });
}

/**
 * A {@link FrameSource} backed by `canvas.captureStream()` of our viewport render
 * — no `getDisplayMedia`, so no share prompt and no user-gesture requirement. A
 * rAF loop keeps the canvas current (for the WebRTC track); `capture()` reads it
 * for JPEG frames.
 */
function demoFrameSource(): FrameSource {
  let stream: MediaStream | undefined;
  let raf = 0;
  const loop = (): void => {
    drawStreamFrame();
    raf = requestAnimationFrame(loop);
  };
  return {
    async start() {
      drawStreamFrame();
      stream = (
        streamCanvas as HTMLCanvasElement & { captureStream(fps?: number): MediaStream }
      ).captureStream(30);
      raf = requestAnimationFrame(loop);
      return true;
    },
    async capture() {
      return canvasToJpeg(streamCanvas, 0.6);
    },
    stream() {
      return stream;
    },
    stop() {
      if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
      for (const track of stream?.getTracks() ?? []) {
        track.stop();
      }
      stream = undefined;
    },
  };
}

// ── toolbar: colors + widths ──────────────────────────────────────────────────
const swatchWrap = document.getElementById("swatches") as HTMLSpanElement;
const swatchEls: HTMLButtonElement[] = [];
for (const color of PALETTE) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "swatch";
  b.style.background = color;
  b.addEventListener("click", () => {
    state.color = color;
    for (const el of swatchEls) el.classList.remove("sel");
    b.classList.add("sel");
  });
  swatchWrap.append(b);
  swatchEls.push(b);
  if (color === state.color) b.classList.add("sel");
}

const widthWrap = document.getElementById("widths") as HTMLSpanElement;
const widthEls: HTMLButtonElement[] = [];
for (const w of WIDTHS) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "wbtn";
  const dot = document.createElement("span");
  Object.assign(dot.style, {
    display: "inline-block",
    width: `${Math.max(4, w)}px`,
    height: `${Math.max(4, w)}px`,
    borderRadius: "50%",
    background: "#e8ebf0",
  });
  b.append(dot);
  b.addEventListener("click", () => {
    state.width = w;
    for (const el of widthEls) el.classList.remove("sel");
    b.classList.add("sel");
  });
  widthWrap.append(b);
  widthEls.push(b);
  if (w === state.width) b.classList.add("sel");
}

(document.getElementById("clear") as HTMLButtonElement).addEventListener("click", () =>
  surface.clear(),
);

// ── remote pen: an InkSink that shifts iPad viewport coordinates into document
// space by the current scroll, so remote ink lands where the iPad sees it ──────
let ipadArmed = false;
const withScroll = (p: SinkPoint): SinkPoint => {
  const q: SinkPoint = { x: p.x + window.scrollX, y: p.y + window.scrollY };
  if (p.pressure !== undefined) q.pressure = p.pressure;
  return q;
};
const sink: InkSink = {
  setArmed(on) {
    ipadArmed = on;
    renderStatus();
  },
  beginStroke(id: string, style: SinkStyle, p: SinkPoint) {
    if (ipadArmed) surface.remoteBegin(id, { style, point: withScroll(p) });
  },
  extendStroke(id: string, p: SinkPoint) {
    surface.remotePoint(id, withScroll(p));
  },
  endStroke(id: string, p?: SinkPoint) {
    surface.remoteEnd(id, p ? withScroll(p) : undefined);
  },
  cancelStroke(id: string) {
    surface.remoteCancel(id);
  },
  size() {
    return { width: window.innerWidth, height: window.innerHeight };
  },
};

// ── the paint host (this page becomes streamable + drawable from an iPad) ──────
const relayUrl = `http://${location.hostname}:${__RELAY_PORT__}`;
let videoMode: "jpeg" | "webrtc" =
  new URLSearchParams(location.search).get("video") === "webrtc" ? "webrtc" : "jpeg";
let host: PaintHost = startHost(videoMode);

function startHost(mode: "jpeg" | "webrtc"): PaintHost {
  return startPaintHost({
    relayUrl,
    ink: sink,
    label: "aiui paint demo",
    video: mode,
    frameSource: demoFrameSource(),
  });
}

// Switch transports live. WebRTC is point-to-point and JPEG is broadcast, so the
// mode is fixed per host connection — flipping it tears down the host and stands
// a fresh one up (a connected iPad re-picks it from the list).
const videoToggle = document.getElementById("videoToggle") as HTMLButtonElement;
function renderToggle(): void {
  videoToggle.textContent = `video: ${videoMode} ⇄`;
}
videoToggle.addEventListener("click", () => {
  host.close();
  videoMode = videoMode === "jpeg" ? "webrtc" : "jpeg";
  host = startHost(videoMode);
  renderToggle();
  renderStatus();
});
renderToggle();

function renderStatus(): void {
  const bits = [`relay :${__RELAY_PORT__}`, `viewers ${host.viewers()}`, `video ${videoMode}`];
  if (ipadArmed) bits.push("iPad armed");
  statusEl.textContent = bits.join("  ·  ");
}
renderStatus();
setInterval(renderStatus, 800);

hintEl.innerHTML =
  "Draw here with your mouse. To draw from an iPad, open the " +
  `<code>http://&lt;this-mac&gt;:${__RELAY_PORT__}/</code> URL printed in your terminal, pick ` +
  "<b>aiui paint demo</b>, tap <b>Arm</b>, then draw. One finger scrolls the document; two fingers " +
  "pinch-zoom. The iPad sees a live render of this page — no screen-share prompt needed.";

window.addEventListener("beforeunload", () => host.close());
