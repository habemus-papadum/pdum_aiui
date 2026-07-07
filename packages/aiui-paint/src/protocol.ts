/**
 * The paint-stream wire protocol.
 *
 * Two planes share one websocket per endpoint:
 *  - **control** — small JSON *text* frames (this module's message unions);
 *  - **video** — raw JPEG *binary* frames, forwarded verbatim, latest-wins.
 * The endpoints tell them apart the way the channel server does: text = JSON,
 * binary = media (see aiui-claude-channel/web.ts). So video never appears in
 * these unions — it is opaque bytes the relay forwards.
 *
 * The design follows `docs/proposals/ipad_browser_paint_stream_design.md`: the
 * iPad sends **intent** in normalized 0..1 coordinates, never synthetic browser
 * events, and the desktop host owns the model. It diverges on transport (a
 * websocket relay carrying JPEG frames now, with an opaque {@link Signal}
 * passthrough so WebRTC video can be layered on later without touching the
 * relay). See the plan doc next to the design.
 *
 * Everything here is pure and dependency-free so it can be shared by the relay
 * (Node), the host controller (browser), and unit tests.
 */

/** The pointing device a stroke came from. */
export type PointerKind = "pen" | "touch" | "mouse";

/**
 * A point in the *displayed content area*, normalized to 0..1 on each axis
 * (`u` horizontal, `v` vertical). Resolution-, DPR-, and scale-independent —
 * each endpoint maps it against its own surface size (see {@link fromNorm}).
 */
export interface NormPoint {
  u: number;
  v: number;
  /** Pen pressure 0..1 when the device reports it. */
  pressure?: number;
  /** Client clock in ms (for later smoothing/velocity); advisory only. */
  time?: number;
}

/** The brush the iPad chose for a stroke: color + nominal width in host px. */
export interface WireStyle {
  color: string;
  width: number;
}

/** Session metadata the relay advertises for each connectable browser host. */
export interface SessionInfo {
  /** Relay-assigned room id the client joins. */
  id: string;
  /** Human label the host announced (page title, app name). */
  label: string;
  /** Project directory the host lives in, when known (for grouping). */
  project?: string;
  /** The aiui channel tag this host belongs to, when it declared one. */
  channelTag?: string;
  /** Whether a client is already viewing this host. */
  busy: boolean;
  /** ISO-8601 time the host connected. */
  connectedAt: string;
}

// ── paint + navigation intent (iPad → host, relayed) ─────────────────────────

/** A drawing or navigation intent the armed iPad produces. */
export type PaintIntent =
  | { type: "setArmed"; armed: boolean }
  | {
      type: "strokeBegin";
      id: string;
      pointerType: PointerKind;
      style: WireStyle;
      point: NormPoint;
    }
  | { type: "strokePoints"; id: string; points: NormPoint[] }
  | { type: "strokeEnd"; id: string; point?: NormPoint }
  | { type: "strokeCancel"; id: string }
  /** Scroll by a fraction of the viewport (`dv` vertical is the one that matters). */
  | { type: "scroll"; du: number; dv: number }
  /** Pinch: multiply zoom by `scale` about a normalized center. */
  | { type: "zoom"; centerU: number; centerV: number; scale: number };

const PAINT_INTENT_TYPES = new Set<PaintIntent["type"]>([
  "setArmed",
  "strokeBegin",
  "strokePoints",
  "strokeEnd",
  "strokeCancel",
  "scroll",
  "zoom",
]);

// ── host → iPad ──────────────────────────────────────────────────────────────

/** The host's periodic view metadata, so the iPad can overlay/interpret. */
export interface ViewState {
  type: "viewState";
  armed: boolean;
  viewportWidth: number;
  viewportHeight: number;
  scrollX: number;
  scrollY: number;
  scrollWidth: number;
  scrollHeight: number;
  documentZoom: number;
}

/**
 * Opaque WebRTC (or other) signaling, forwarded by the relay. The payload
 * (`data`) is untouched — SDP descriptions and ICE candidates for the host↔iPad
 * peer connection.
 *
 * `peer` addresses a specific viewer, because WebRTC is point-to-point while a
 * host can have several: the host sends `{ peer: <clientId>, … }` and the relay
 * routes it to that one client; a client sends no `peer`, and the relay stamps
 * the sender's id as `peer` before handing it to the host. (Control intents and
 * JPEG frames still broadcast to the whole room — only signaling is addressed.)
 */
export interface Signal {
  type: "signal";
  /** Target viewer id (host→client); stamped by the relay on client→host. */
  peer?: string;
  data: unknown;
}

// ── control-plane message unions (endpoint ↔ relay) ──────────────────────────

/** iPad client → relay. */
export type ClientToRelay =
  | { type: "join"; host: string }
  | { type: "leave" }
  | PaintIntent
  | Signal;

/** relay → iPad client. */
export type RelayToClient =
  | { type: "sessions"; sessions: SessionInfo[] }
  | { type: "joined"; host: string; label: string }
  | { type: "joinRejected"; reason: string }
  | { type: "hostGone" }
  | ViewState
  | Signal;

/** browser host → relay. */
export type HostToRelay =
  | {
      type: "register";
      label: string;
      project?: string;
      channelTag?: string;
      /**
       * The aiui channel web-backend port the host's page was launched with
       * (`window.__AIUI__.port`). The relay — same machine — resolves it against
       * the on-disk server registry to fill in the project dir and channel tag,
       * so the iPad's session list shows which agent session each browser belongs
       * to without the browser needing registry access.
       */
      channelPort?: number;
    }
  | ViewState
  | Signal;

/** relay → browser host. */
export type RelayToHost =
  | { type: "registered"; id: string }
  | { type: "clientJoined"; client: string }
  | { type: "clientLeft"; client: string }
  | PaintIntent
  | Signal;

/** Any control message that can cross the wire. */
export type WireMessage = ClientToRelay | RelayToClient | HostToRelay | RelayToHost;

/** Serialize a control message to a JSON text frame. */
export function encode(message: WireMessage): string {
  return JSON.stringify(message);
}

/**
 * Parse a JSON text frame into a control message, or `undefined` if it isn't a
 * well-formed message (not JSON, not an object, or no string `type`). The wire
 * is a trusted loopback/LAN channel, so validation is shallow-but-safe: it
 * guards against crashes on garbage, not against a malicious peer.
 */
export function decode(raw: string): WireMessage | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }
  const type = (parsed as { type?: unknown }).type;
  if (typeof type !== "string") {
    return undefined;
  }
  return parsed as WireMessage;
}

/** Narrow a decoded message to a {@link PaintIntent} (what the host applies). */
export function isPaintIntent(message: { type: string }): message is PaintIntent {
  return PAINT_INTENT_TYPES.has(message.type as PaintIntent["type"]);
}

// ── normalized-coordinate helpers ────────────────────────────────────────────

/** Map a point in a `w × h` area to normalized 0..1 (clamped). */
export function toNorm(x: number, y: number, w: number, h: number): { u: number; v: number } {
  return {
    u: w > 0 ? clamp01(x / w) : 0,
    v: h > 0 ? clamp01(y / h) : 0,
  };
}

/** Map a normalized 0..1 point back into a `w × h` area's pixels. */
export function fromNorm(u: number, v: number, w: number, h: number): { x: number; y: number } {
  return { x: u * w, y: v * h };
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}
