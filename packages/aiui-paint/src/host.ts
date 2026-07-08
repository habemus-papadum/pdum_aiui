/**
 * The desktop **host** side of the paint stream — the browser page that owns the
 * painting model. It:
 *   - connects to the relay as a host and announces itself;
 *   - while a viewer is joined, streams the tab as video — downscaled JPEG frames
 *     (`video: "jpeg"`, default) or a WebRTC track per viewer (`video: "webrtc"`) —
 *     plus periodic view-state;
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
import {
  type CaptureState,
  fromNorm,
  type NormPoint,
  type PaintIntent,
  type ViewState,
} from "./protocol";

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

/** A source of screen frames the host streams to viewers. */
export interface FrameSource {
  /**
   * Acquire the capture (may prompt). Resolves the resulting {@link CaptureState}:
   * `"active"` once frames/tracks are available, `"needsGesture"` if it can't
   * start without a fresh user gesture (e.g. `getDisplayMedia` off a network
   * event), or `"denied"` if the user refused. A source that never needs a
   * gesture (e.g. a canvas) resolves `"active"`/`"denied"` only.
   */
  start(): Promise<CaptureState>;
  /**
   * The last `start()` failure, verbatim (`"NotReadableError: Could not start
   * video source"`), or undefined after a success / before any attempt. Rides
   * the `videoStatus` broadcast so the viewer can show *why* — a capture that
   * fails with no picker (wrong browser flags, a missing OS screen-recording
   * grant) is otherwise indistinguishable from the user dismissing it.
   */
  lastError?(): string | undefined;
  /** Grab one JPEG frame, or undefined if the grant was lost (frame-streaming mode). */
  capture(): Promise<Uint8Array | undefined>;
  /**
   * The live capture `MediaStream` (WebRTC mode adds its tracks to each peer
   * connection). Undefined until `start()` succeeds, or on a source that only
   * supports frame streaming. The same stream backs both modes — one grant.
   */
  stream?(): MediaStream | undefined;
  stop(): void;
}

/** Longest edge (CSS px) a streamed frame is downscaled to. Bandwidth vs. legibility. */
const MAX_FRAME_EDGE = 1280;
const FRAME_JPEG_QUALITY = 0.6;

/**
 * The default frame source: `getDisplayMedia({ preferCurrentTab })`, sampled to a
 * downscaled JPEG. Browser-only.
 *
 * `getDisplayMedia` requires **transient user activation** — a recent click — and
 * a secure context (`https:` or `http://localhost`). A viewer joining is a network
 * event with no activation, so `start()` pre-checks `navigator.userActivation` and
 * returns `"needsGesture"` rather than firing a call the browser will reject. Call
 * {@link PaintHost.requestCapture} from a real click (a "Share screen" button) to
 * acquire it. See the guide's note; a host that renders its own content can
 * sidestep all of this with a `canvas.captureStream()` source instead.
 */
export function displayCaptureSource(): FrameSource {
  let stream: MediaStream | undefined;
  let video: HTMLVideoElement | undefined;
  let lastError: string | undefined;
  return {
    async start() {
      // Transient activation is required; if the browser tells us there is none,
      // don't fire a doomed prompt — report that a gesture is needed.
      const activation = typeof navigator !== "undefined" ? navigator.userActivation : undefined;
      if (activation && !activation.isActive) {
        return "needsGesture";
      }
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
        lastError = undefined;
        stream.getVideoTracks()[0]?.addEventListener("ended", () => {
          stream = undefined;
          video = undefined;
        });
        return "active";
      } catch (error) {
        // Keep the real reason: a NotAllowedError is the user dismissing the
        // picker, but a NotReadableError with no picker shown is an environment
        // bug (browser flags, OS screen-recording grant) — the difference is
        // exactly what a human debugging "share does nothing" needs to see.
        lastError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        // With activation we know the attempt itself failed; without the API
        // we can't tell a stale-gesture rejection from a refusal, so allow a retry.
        return activation ? "denied" : "needsGesture";
      }
    },
    lastError() {
      return lastError;
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
    stream() {
      return stream;
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
  /**
   * Video transport. `"webrtc"` (default) negotiates a peer connection per
   * viewer (SDP/ICE over the relay's `signal` passthrough) — smooth,
   * low-latency video. `"jpeg"` streams downscaled JPEG frames over the relay —
   * simple, works everywhere. JPEG is also the automatic **backup**: a host
   * whose environment can't do WebRTC (no `RTCPeerConnection`, a frame-only
   * `FrameSource` with no `MediaStream`) or whose peer connection fails falls
   * back to frame streaming by itself. Control/ink is identical in both.
   * Falls back to no video only when capture is denied.
   */
  video?: "jpeg" | "webrtc";
  /** WebRTC config (ICE servers). Defaults to `{ iceServers: [] }` — host-only, LAN. */
  rtcConfig?: RTCConfiguration;
  /** Frame rate while a viewer is watching (JPEG mode). Defaults to 8. */
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
  /** Current screen-capture state (drives the "share your screen" affordance). */
  captureState: () => CaptureState;
  /** The last capture failure, verbatim (see {@link FrameSource.lastError}). */
  captureError: () => string | undefined;
  /**
   * Attempt to acquire screen capture now and stream to any waiting viewers.
   * **Call this from a real user gesture** (e.g. a button click) — `getDisplayMedia`
   * needs transient activation. Resolves the resulting {@link CaptureState}.
   */
  requestCapture: () => Promise<CaptureState>;
  close: () => void;
}

/**
 * Derive the `…/host` websocket URL from an http(s) or ws(s) backend base,
 * PRESERVING the base's path — `http://127.0.0.1:4321/paint` (the channel
 * sidecar) becomes `ws://127.0.0.1:4321/paint/host`; a bare origin (the
 * standalone demo) becomes `ws://…/host`.
 */
export function hostWsUrl(relayUrl: string): string {
  const url = new URL(relayUrl);
  url.protocol = url.protocol === "https:" || url.protocol === "wss:" ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/host`;
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
  const videoMode = options.video ?? "webrtc";
  const rtcConfig: RTCConfiguration = options.rtcConfig ?? { iceServers: [] };
  const nav: NavHandlers = {
    scroll: options.nav?.scroll ?? windowScroll,
    zoom: options.nav?.zoom ?? makeTransformZoom(),
  };
  const frames = options.frameSource ?? displayCaptureSource();
  let armed = false;
  let hostId: string | undefined;
  // Current viewers, by relay-assigned client id (so WebRTC can re-open peers for
  // everyone once capture finally starts).
  const viewerIds = new Set<string>();
  let captureState: CaptureState = "idle";
  let ws: WebSocket | undefined;
  let frameTimer: ReturnType<typeof setInterval> | undefined;
  let viewTimer: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  // One RTCPeerConnection per viewer (WebRTC is point-to-point). Keyed by the
  // relay-assigned client id that rides clientJoined/clientLeft/signal.
  const peers = new Map<string, RTCPeerConnection>();

  const url = hostWsUrl(options.relayUrl);

  const sendJson = (message: object): void => {
    if (ws && ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(message));
    }
  };

  const broadcastVideoStatus = (): void => {
    const detail = frames.lastError?.();
    sendJson({
      type: "videoStatus",
      state: captureState,
      ...(detail !== undefined ? { detail } : {}),
    });
  };

  // Acquire the screen-capture grant once; keep it for the host's lifetime so
  // viewers coming and going don't re-prompt. Broadcasts the resulting state so a
  // viewer sees "waiting for the desktop to share" instead of a black rectangle.
  // Returns whether capture is live. Single-flight: two viewers joining at once
  // must not race two getDisplayMedia prompts.
  let capturing: Promise<boolean> | undefined;
  const ensureCapture = (): Promise<boolean> => {
    if (captureState === "active") {
      return Promise.resolve(true);
    }
    capturing ??= frames
      .start()
      .then((state) => {
        captureState = state;
        if (state !== "active" && state !== "needsGesture") {
          // Loud on the host page too: the viewer gets the detail over the
          // relay, but the person clicking "Share screen" is HERE.
          console.warn(
            `[aiui-paint] screen capture ${state}${frames.lastError?.() ? ` — ${frames.lastError()}` : ""}`,
          );
        }
        broadcastVideoStatus();
        return state === "active";
      })
      .finally(() => {
        capturing = undefined;
      });
    return capturing;
  };

  const startViewLoop = (): void => {
    if (viewTimer) {
      return;
    }
    viewTimer = setInterval(() => {
      sendJson(options.viewState ? options.viewState() : defaultViewState(armed));
    }, 500);
  };

  // A socket this far behind (bytes buffered) skips frames until it drains —
  // video is latest-wins; unbounded buffering on a slow link is not.
  const MAX_BUFFERED = 1_500_000;

  const startFrameLoop = async (): Promise<void> => {
    if (frameTimer) {
      return; // already running
    }
    if (!(await ensureCapture())) {
      return; // capture denied / needs a gesture — control still works
    }
    if (frameTimer) {
      return; // a concurrent caller won the race during the await
    }
    frameTimer = setInterval(
      () => {
        if (ws && ws.bufferedAmount > MAX_BUFFERED) {
          return; // the relay link is backed up — skip this frame entirely
        }
        void frames.capture().then((bytes) => {
          if (bytes && ws && ws.readyState === ws.OPEN) {
            // Browser WebSocket sends a typed array as a binary frame automatically.
            ws.send(bytes);
          }
        });
      },
      Math.max(1, Math.round(1000 / fps)),
    );
  };

  const stopLoops = (): void => {
    if (frameTimer) {
      clearInterval(frameTimer);
      frameTimer = undefined;
    }
    if (viewTimer) {
      clearInterval(viewTimer);
      viewTimer = undefined;
    }
  };

  // ── WebRTC: the host is the offerer, one peer connection per viewer ──────────
  const openPeer = async (clientId: string): Promise<void> => {
    if (peers.has(clientId) || !(await ensureCapture())) {
      return;
    }
    const stream = frames.stream?.();
    if (!stream || typeof RTCPeerConnection === "undefined") {
      // No MediaStream (a frame-only source) or no WebRTC in this environment —
      // fall back to JPEG frame streaming rather than showing nothing.
      void startFrameLoop();
      return;
    }
    const pc = new RTCPeerConnection(rtcConfig);
    peers.set(clientId, pc);
    for (const track of stream.getTracks()) {
      pc.addTrack(track, stream);
    }
    pc.addEventListener("icecandidate", (e) => {
      if (e.candidate) {
        sendJson({ type: "signal", peer: clientId, data: { candidate: e.candidate } });
      }
    });
    pc.addEventListener("connectionstatechange", () => {
      if (pc.connectionState === "failed") {
        // WebRTC couldn't get through (ICE, network) — JPEG over the already-
        // working relay socket is the backup, for as long as viewers remain.
        console.warn(
          `[aiui-paint] WebRTC to viewer ${clientId} failed (ICE/network) — falling back to JPEG frame streaming`,
        );
        closePeer(clientId);
        void startFrameLoop();
      } else if (pc.connectionState === "closed") {
        closePeer(clientId);
      }
    });
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      sendJson({ type: "signal", peer: clientId, data: { description: pc.localDescription } });
    } catch {
      closePeer(clientId);
      void startFrameLoop(); // negotiation never started — use the backup
    }
  };

  const closePeer = (clientId: string): void => {
    const pc = peers.get(clientId);
    if (pc) {
      try {
        pc.close();
      } catch {
        // already closing
      }
      peers.delete(clientId);
    }
  };

  const handleSignal = (peer: string | undefined, data: unknown): void => {
    if (!peer || !data || typeof data !== "object") {
      return;
    }
    const pc = peers.get(peer);
    if (!pc) {
      return;
    }
    const payload = data as {
      description?: RTCSessionDescriptionInit;
      candidate?: RTCIceCandidateInit;
    };
    if (payload.description) {
      void pc.setRemoteDescription(payload.description).catch(() => {});
    } else if (payload.candidate) {
      void pc.addIceCandidate(payload.candidate).catch(() => {});
    }
  };

  // Stream to one viewer using the active transport. Both paths call
  // ensureCapture; if capture isn't live yet they no-op until requestCapture arms it.
  const streamToViewer = (clientId: string): void => {
    if (videoMode === "webrtc") {
      void openPeer(clientId);
    } else {
      void startFrameLoop();
    }
  };

  const onClientJoined = (clientId: string): void => {
    viewerIds.add(clientId);
    startViewLoop();
    if (captureState === "active") {
      broadcastVideoStatus(); // a viewer joining an already-sharing host learns it now
    }
    streamToViewer(clientId);
  };

  const onClientLeft = (clientId: string): void => {
    viewerIds.delete(clientId);
    closePeer(clientId);
    if (viewerIds.size === 0) {
      stopLoops(); // capture stays acquired for the next viewer
    }
  };

  // Acquire capture from a user gesture (a button), then stream to everyone who
  // was already waiting. The public entry point behind a "Share screen" button.
  const requestCapture = async (): Promise<CaptureState> => {
    const wasActive = captureState === "active";
    await ensureCapture();
    if (captureState === "active" && !wasActive) {
      if (videoMode === "webrtc") {
        for (const clientId of viewerIds) {
          void openPeer(clientId);
        }
      } else {
        void startFrameLoop();
      }
    }
    return captureState;
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
      } else if (message.type === "clientJoined" && typeof message.client === "string") {
        onClientJoined(message.client);
      } else if (message.type === "clientLeft" && typeof message.client === "string") {
        onClientLeft(message.client);
      } else if (message.type === "signal") {
        handleSignal(typeof message.peer === "string" ? message.peer : undefined, message.data);
      } else if (message.type === "setArmed" && typeof message.armed === "boolean") {
        armed = message.armed; // tracked for the view-state badge
        applyIntent(message as PaintIntent, options.ink, nav);
      } else if (message.type && isIntentType(message.type)) {
        applyIntent(message as PaintIntent, options.ink, nav);
      }
    });
    ws.addEventListener("close", () => {
      stopLoops();
      for (const clientId of [...peers.keys()]) {
        closePeer(clientId);
      }
      viewerIds.clear(); // the capture grant survives the reconnect; the room does not
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
    viewers: () => viewerIds.size,
    captureState: () => captureState,
    captureError: () => frames.lastError?.(),
    requestCapture,
    close: () => {
      closed = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
      }
      stopLoops();
      for (const clientId of [...peers.keys()]) {
        closePeer(clientId);
      }
      frames.stop();
      captureState = "idle";
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
