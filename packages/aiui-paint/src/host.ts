/**
 * The desktop **host** side of the paint stream — the browser page that owns the
 * painting model. It:
 *   - connects to the relay as a host and announces itself;
 *   - while a viewer is joined, streams downscaled JPEG frames of the tab and
 *     periodic view-state;
 *   - applies incoming paint/navigation intents to an {@link InkSink} (arm,
 *     strokes) and to scroll/zoom handlers, mapping normalized 0..1 coordinates
 *     into its own surface pixels.
 *
 * The host never trusts the iPad to name pixels — it re-maps everything against
 * its live surface size, so the same intent is correct at any iPad resolution
 * (the design doc's rule: the desktop owns coordinate mapping).
 *
 * `applyIntent` and the sink adapters are pure and unit-tested; the socket +
 * screen-capture wiring is browser-only and exercised by hand / the example.
 */
import { fromNorm, type NormPoint, type PaintIntent, type ViewState } from "./protocol";

/** Minimal px point the sink draws with. */
export interface SinkPoint {
  x: number;
  y: number;
  pressure?: number;
}

/** Per-stroke brush the iPad chose. */
export interface SinkStyle {
  color: string;
  width: number;
}

/**
 * Where the host lands remote ink. An {@link InkSurface} from `aiui-ink` adapts
 * to this via {@link inkSurfaceSink}; the overlay provides its own so remote
 * strokes join the intent tool (and its screenshots). Points are in the sink's
 * own CSS pixels.
 */
export interface InkSink {
  /** Arm/disarm remote drawing. Disarmed, stroke intents are dropped. */
  setArmed(on: boolean): void;
  beginStroke(id: string, style: SinkStyle, point: SinkPoint): void;
  extendStroke(id: string, point: SinkPoint): void;
  endStroke(id: string, point?: SinkPoint): void;
  cancelStroke(id: string): void;
  /** The sink's CSS-pixel size, used to map normalized coordinates. */
  size(): { width: number; height: number };
}

/** Scroll + zoom handlers the host applies navigation intents through. */
export interface NavHandlers {
  scroll: (du: number, dv: number) => void;
  zoom: (centerU: number, centerV: number, scale: number) => void;
}

/** The subset of `aiui-ink`'s InkSurface {@link inkSurfaceSink} needs. */
export interface RemoteInkTarget {
  remoteBegin(id: string, init: { style: SinkStyle; point: SinkPoint }): void;
  remotePoint(id: string, point: SinkPoint): void;
  remoteEnd(id: string, point?: SinkPoint): void;
  remoteCancel(id: string): void;
  size(): { width: number; height: number };
}

/**
 * Adapt an `aiui-ink` {@link InkSurface} into an {@link InkSink}. Arming gates
 * whether remote strokes are drawn; a stroke begun while disarmed simply never
 * starts (its later points reference an unknown id, which the surface ignores).
 */
export function inkSurfaceSink(surface: RemoteInkTarget, initialArmed = false): InkSink {
  let armed = initialArmed;
  return {
    setArmed(on) {
      armed = on;
    },
    beginStroke(id, style, point) {
      if (armed) {
        surface.remoteBegin(id, { style, point });
      }
    },
    extendStroke(id, point) {
      surface.remotePoint(id, point);
    },
    endStroke(id, point) {
      surface.remoteEnd(id, point);
    },
    cancelStroke(id) {
      surface.remoteCancel(id);
    },
    size() {
      return surface.size();
    },
  };
}

/** Map a normalized wire point into the sink's pixels, carrying pressure/time. */
function toSinkPoint(point: NormPoint, size: { width: number; height: number }): SinkPoint {
  const { x, y } = fromNorm(point.u, point.v, size.width, size.height);
  return point.pressure === undefined ? { x, y } : { x, y, pressure: point.pressure };
}

/**
 * Apply one intent to the sink + navigation handlers. Pure given its
 * collaborators — the tested core of the host.
 */
export function applyIntent(intent: PaintIntent, sink: InkSink, nav: NavHandlers): void {
  switch (intent.type) {
    case "setArmed":
      sink.setArmed(intent.armed);
      break;
    case "strokeBegin":
      sink.beginStroke(intent.id, intent.style, toSinkPoint(intent.point, sink.size()));
      break;
    case "strokePoints": {
      const size = sink.size();
      for (const point of intent.points) {
        sink.extendStroke(intent.id, toSinkPoint(point, size));
      }
      break;
    }
    case "strokeEnd":
      sink.endStroke(intent.id, intent.point ? toSinkPoint(intent.point, sink.size()) : undefined);
      break;
    case "strokeCancel":
      sink.cancelStroke(intent.id);
      break;
    case "scroll":
      nav.scroll(intent.du, intent.dv);
      break;
    case "zoom":
      nav.zoom(intent.centerU, intent.centerV, intent.scale);
      break;
  }
}

// ── screen-capture frame source ──────────────────────────────────────────────

/** A source of JPEG frames the host streams to viewers. */
export interface FrameSource {
  /** Acquire the capture (may prompt); resolves false if denied/unavailable. */
  start(): Promise<boolean>;
  /** Grab one JPEG frame, or undefined if the grant was lost. */
  capture(): Promise<Uint8Array | undefined>;
  stop(): void;
}

/** Longest edge (CSS px) a streamed frame is downscaled to. Bandwidth vs. legibility. */
const MAX_FRAME_EDGE = 1280;
const FRAME_JPEG_QUALITY = 0.6;

/**
 * The default frame source: `getDisplayMedia({ preferCurrentTab })` (the same
 * one-time grant the overlay's shot tool uses — auto-accepted in the session
 * browser), sampled to a downscaled JPEG. Browser-only.
 */
export function displayCaptureSource(): FrameSource {
  let stream: MediaStream | undefined;
  let video: HTMLVideoElement | undefined;
  return {
    async start() {
      try {
        stream = await (
          navigator.mediaDevices as MediaDevices & {
            getDisplayMedia(o?: object): Promise<MediaStream>;
          }
        ).getDisplayMedia({ video: true, preferCurrentTab: true, audio: false });
        const el = document.createElement("video");
        el.srcObject = stream;
        el.muted = true;
        await el.play();
        video = el;
        stream.getVideoTracks()[0]?.addEventListener("ended", () => {
          stream = undefined;
          video = undefined;
        });
        return true;
      } catch {
        return false;
      }
    },
    async capture() {
      if (!video) {
        return undefined;
      }
      const vw = video.videoWidth || window.innerWidth;
      const vh = video.videoHeight || window.innerHeight;
      const scale = Math.min(1, MAX_FRAME_EDGE / Math.max(vw, vh));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(vw * scale));
      canvas.height = Math.max(1, Math.round(vh * scale));
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        return undefined;
      }
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      return canvasJpeg(canvas, FRAME_JPEG_QUALITY);
    },
    stop() {
      for (const track of stream?.getTracks() ?? []) {
        track.stop();
      }
      stream = undefined;
      video = undefined;
    },
  };
}

function canvasJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Uint8Array | undefined> {
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

// ── default navigation ───────────────────────────────────────────────────────

/** Scroll the window by a fraction of its viewport (`dv` vertical, `du` horizontal). */
export function windowScroll(du: number, dv: number): void {
  window.scrollBy(du * window.innerWidth, dv * window.innerHeight);
}

/**
 * Approximate default zoom: accumulate a CSS `transform: scale()` on an element
 * (default `document.body`), origin at the pinch center. Apps with their own
 * viewport model should pass a real `onZoom` instead — transforms interact badly
 * with fixed positioning. Kept minimal and clamped.
 */
export function makeTransformZoom(
  el: HTMLElement = document.body,
  min = 0.25,
  max = 8,
): NavHandlers["zoom"] {
  let zoom = 1;
  return (centerU, centerV, scale) => {
    zoom = Math.max(min, Math.min(max, zoom * scale));
    el.style.transformOrigin = `${centerU * 100}% ${centerV * 100}%`;
    el.style.transform = zoom === 1 ? "" : `scale(${zoom})`;
  };
}

// ── the host controller ──────────────────────────────────────────────────────

export interface PaintHostOptions {
  /** Relay base URL, e.g. `http://mac.local:8788` or `ws://…`. `/host` is appended. */
  relayUrl: string;
  /** Where remote ink lands. */
  ink: InkSink;
  /** Human label shown in the iPad's session list. Defaults to `document.title`. */
  label?: string;
  /** Project dir + channel identity, surfaced in the session list. */
  project?: string;
  channelTag?: string;
  /** The channel web-backend port (`window.__AIUI__.port`) for registry enrichment. */
  channelPort?: number;
  /** Frame source. Defaults to {@link displayCaptureSource}. */
  frameSource?: FrameSource;
  /** Frame rate while a viewer is watching. Defaults to 8. */
  fps?: number;
  /** Navigation handlers. Default: window scroll + approximate transform zoom. */
  nav?: Partial<NavHandlers>;
  /** Build the per-tick view-state. Default reads window scroll/size. */
  viewState?: () => ViewState;
  /** WebSocket constructor (injected in tests). Defaults to the global. */
  WebSocketImpl?: typeof WebSocket;
}

export interface PaintHost {
  /** The relay-assigned host id, once registered. */
  id: () => string | undefined;
  /** Number of viewers currently joined. */
  viewers: () => number;
  close: () => void;
}

/** Derive the `ws://…/host` URL from an http(s) or ws(s) relay base. */
export function hostWsUrl(relayUrl: string): string {
  const url = new URL(relayUrl);
  url.protocol = url.protocol === "https:" || url.protocol === "wss:" ? "wss:" : "ws:";
  url.pathname = "/host";
  url.search = "";
  return url.toString();
}

/** Default view-state from the window. */
function defaultViewState(armed: boolean): ViewState {
  const doc = document.documentElement;
  return {
    type: "viewState",
    armed,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    scrollX: window.scrollX,
    scrollY: window.scrollY,
    scrollWidth: doc.scrollWidth,
    scrollHeight: doc.scrollHeight,
    documentZoom: 1,
  };
}

/**
 * Start the desktop host. Browser-only (opens a websocket, captures the screen).
 * Reconnects on drop with a short backoff.
 */
export function startPaintHost(options: PaintHostOptions): PaintHost {
  const WS = options.WebSocketImpl ?? WebSocket;
  const fps = options.fps ?? 8;
  const nav: NavHandlers = {
    scroll: options.nav?.scroll ?? windowScroll,
    zoom: options.nav?.zoom ?? makeTransformZoom(),
  };
  const frames = options.frameSource ?? displayCaptureSource();
  let armed = false;
  let hostId: string | undefined;
  let viewers = 0;
  let ws: WebSocket | undefined;
  let frameTimer: ReturnType<typeof setInterval> | undefined;
  let viewTimer: ReturnType<typeof setInterval> | undefined;
  let capturing = false;
  let closed = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  const url = hostWsUrl(options.relayUrl);

  const sendJson = (message: object): void => {
    if (ws && ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(message));
    }
  };

  const startStreaming = async (): Promise<void> => {
    if (capturing) {
      return;
    }
    capturing = (await frames.start()) === true;
    if (!capturing) {
      return; // capture denied — the viewer sees no video, control still works
    }
    frameTimer = setInterval(
      () => {
        void frames.capture().then((bytes) => {
          if (bytes && ws && ws.readyState === ws.OPEN) {
            // Browser WebSocket sends a typed array as a binary frame automatically.
            ws.send(bytes);
          }
        });
      },
      Math.max(1, Math.round(1000 / fps)),
    );
    viewTimer = setInterval(() => {
      sendJson(options.viewState ? options.viewState() : defaultViewState(armed));
    }, 500);
  };

  const stopStreaming = (): void => {
    if (frameTimer) {
      clearInterval(frameTimer);
      frameTimer = undefined;
    }
    if (viewTimer) {
      clearInterval(viewTimer);
      viewTimer = undefined;
    }
    frames.stop();
    capturing = false;
  };

  const connect = (): void => {
    ws = new WS(url) as WebSocket;
    ws.binaryType = "arraybuffer";
    ws.addEventListener("open", () => {
      sendJson({
        type: "register",
        label: options.label ?? (typeof document !== "undefined" ? document.title : "browser"),
        ...(options.project !== undefined ? { project: options.project } : {}),
        ...(options.channelTag !== undefined ? { channelTag: options.channelTag } : {}),
        ...(options.channelPort !== undefined ? { channelPort: options.channelPort } : {}),
      });
    });
    ws.addEventListener("message", (event: MessageEvent) => {
      if (typeof event.data !== "string") {
        return; // the host receives only control frames
      }
      let message: { type?: string } & Record<string, unknown>;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.type === "registered" && typeof message.id === "string") {
        hostId = message.id;
      } else if (message.type === "clientJoined") {
        viewers += 1;
        if (viewers === 1) {
          void startStreaming();
        }
      } else if (message.type === "clientLeft") {
        viewers = Math.max(0, viewers - 1);
        if (viewers === 0) {
          stopStreaming();
        }
      } else if (message.type === "setArmed" && typeof message.armed === "boolean") {
        armed = message.armed; // tracked for the view-state badge
        applyIntent(message as PaintIntent, options.ink, nav);
      } else if (message.type && isIntentType(message.type)) {
        applyIntent(message as PaintIntent, options.ink, nav);
      }
      // `signal` frames (future WebRTC) are relayed to us but not yet consumed.
    });
    ws.addEventListener("close", () => {
      stopStreaming();
      viewers = 0;
      if (!closed) {
        reconnectTimer = setTimeout(connect, 1000);
      }
    });
    ws.addEventListener("error", () => {
      /* close follows */
    });
  };
  connect();

  return {
    id: () => hostId,
    viewers: () => viewers,
    close: () => {
      closed = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
      }
      stopStreaming();
      ws?.close();
    },
  };
}

const INTENT_TYPES = new Set([
  "strokeBegin",
  "strokePoints",
  "strokeEnd",
  "strokeCancel",
  "scroll",
  "zoom",
]);
function isIntentType(type: string): boolean {
  return INTENT_TYPES.has(type);
}
