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
 * Launched by `demo/serve.ts` (`pnpm paint:demo`), which starts the relay and
 * this Vite app together and injects the relay port below.
 */
import {
  type InkSink,
  InkSurface,
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
    width: "300px",
    height: "180px",
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

// ── toolbar ──────────────────────────────────────────────────────────────────
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
const video = new URLSearchParams(location.search).get("video") === "webrtc" ? "webrtc" : "jpeg";
const host = startPaintHost({ relayUrl, ink: sink, label: "aiui paint demo", video });

function renderStatus(): void {
  const bits = [`relay :${__RELAY_PORT__}`, `viewers ${host.viewers()}`, `video ${video}`];
  if (ipadArmed) bits.push("iPad armed");
  statusEl.textContent = bits.join("  ·  ");
}
renderStatus();
setInterval(renderStatus, 800);

hintEl.innerHTML =
  "Draw here with your mouse. To draw from an iPad, open the " +
  `<code>http://&lt;this-mac&gt;:${__RELAY_PORT__}/</code> URL printed in your terminal, pick ` +
  "<b>aiui paint demo</b>, tap <b>Arm</b>, then draw. One finger scrolls the document; two fingers " +
  "pinch-zoom. (The first iPad connection asks this tab to share its screen.)";

window.addEventListener("beforeunload", () => host.close());
