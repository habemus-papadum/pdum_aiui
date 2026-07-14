/**
 * protocol.ts — the remote-pencil wire.
 *
 * One websocket per endpoint, **three planes**, and they are designed together
 * because a wire is cheap to design once and expensive to design twice:
 *
 *   ink      iPad → host    strokes, as intent — never synthetic pointer events
 *   view     host → iPad    JPEG frames (binary) + the ack that retires previews
 *   control  both ways      the mode engine's bar down, a command back up
 *
 * ## No frame identity, on purpose (plan decision D3)
 *
 * The iPad draws a **local preview** so the pen feels immediate — nothing over a
 * network can — while the truth, the host's screen, arrives as WebRTC video (D1)
 * a beat later. From pen-up the preview cross-fades out over a fixed window
 * (`fadeWindowMs` in remote.ts; ~500 ms, the constant the paint stream shipped
 * and proved), by which time the video's copy has almost certainly arrived
 * underneath. We deliberately do NOT correlate strokes with the specific frame
 * that contains them: the host renders strokes progressively, so a translucent
 * stroke is briefly rendered by both sides *regardless* of any ack, and exact
 * retirement would have cost a vendor-dependent per-frame metadata dependency to
 * fix only the tail of it. So the wire carries **no frame metadata at all** —
 * video never touches this protocol, and the only view-plane messages are
 * {@link Signal} (the peer connection's side-channel) and {@link VideoStatus}
 * (why there is no picture).
 *
 * ## Why normalized coordinates, and why rich points
 *
 * The iPad sends `u, v` in 0..1 of the displayed content area — resolution-,
 * DPR-, and zoom-independent, so an iPad mini and a 6K display are the same
 * client. And it sends the *whole* pen: pressure, altitude, azimuth, time. The
 * host must be able to render exactly what the Lab renders, and the Lab's
 * instrument is a function of all four (see `dabs.ts`). Dropping tilt on the
 * wire would silently reduce the remote pencil to a pen with no charcoal in it.
 *
 * The `mode` and `tool` ride on `strokeBegin`, not the resolved parameters: the
 * **host owns the brush**. The iPad resolves the same preset locally for its
 * preview, so the two agree without the wire carrying a parameter block per
 * stroke — and when the presets are re-tuned, they are re-tuned in one place.
 *
 * Pure and dependency-free: shared verbatim by the relay (node), the host
 * (browser), the iPad client (browser), and the tests.
 */

import type { PencilMode } from "./pencil";
import type { Tool } from "./surface";
import type { PenSample } from "./telemetry";

/** Wire protocol version. Bumped when a change is not backward compatible. */
export const PROTOCOL_VERSION = 2;

/** The pointing device a stroke came from. */
export type PointerKind = "pen" | "touch" | "mouse";

/**
 * A pen sample in **normalized content coordinates** — `u`,`v` in 0..1 — with the
 * rest of the instrument's inputs intact.
 *
 * Short keys on purpose: these fly at 120 Hz, and while the bandwidth is trivial
 * the JSON *parse* cost on the host is not entirely (a long stroke is thousands
 * of these). Everything but position is optional, because a finger or a mouse
 * genuinely has none of it, and the renderer degrades by design rather than by
 * branch (an absent altitude means "upright", which is what a mouse is).
 */
export interface WirePoint {
  u: number;
  v: number;
  /** Client clock, ms. Velocity and the fade both need real time, not arrival time. */
  t: number;
  /** Pressure 0..1. */
  p?: number;
  /** Altitude from the page, radians (π/2 = upright). */
  alt?: number;
  /** Azimuth, radians. */
  az?: number;
}

/** iPad → host: drawing intent. Never synthetic events — the host owns the model. */
export type InkIntent =
  | {
      type: "strokeBegin";
      id: string;
      pointerType: PointerKind;
      /** Which end of the instrument, and which preset. The host resolves both. */
      tool: Tool;
      mode: PencilMode;
      point: WirePoint;
    }
  | { type: "strokePoints"; id: string; points: WirePoint[] }
  | { type: "strokeEnd"; id: string; point?: WirePoint }
  | { type: "strokeCancel"; id: string }
  /** Lift the last stroke — an eraser can itself be undone (see surface.ts). */
  | { type: "undo" }
  | { type: "clear" }
  /**
   * Navigation gestures against the plane — paint v1's proven shapes (D5 keeps
   * them HERE, not on the bar: they are continuous gestures, not commands, and
   * routing 60 of them a second through a mode-engine reducer would be wrong).
   * Scroll is a fraction of the plane per step; zoom multiplies about a
   * normalized center.
   */
  | { type: "scroll"; du: number; dv: number }
  | { type: "zoom"; centerU: number; centerV: number; scale: number };

const INK_INTENT_TYPES: ReadonlySet<string> = new Set([
  "strokeBegin",
  "strokePoints",
  "strokeEnd",
  "strokeCancel",
  "undo",
  "clear",
  "scroll",
  "zoom",
]);

/** True when `value` is drawing intent — the relay's routing test, and the host's guard. */
export function isInkIntent(value: unknown): value is InkIntent {
  return (
    typeof value === "object" &&
    value !== null &&
    INK_INTENT_TYPES.has((value as { type?: unknown }).type as string)
  );
}

// ── view plane: what the iPad is looking at ─────────────────────────────────

/**
 * Opaque WebRTC signaling, forwarded verbatim by the relay — the peer
 * connection's offer/answer/ICE side-channel (D1: video is a track, and a track
 * needs this to exist). The payload is untouched.
 *
 * `peer` addresses a specific viewer, because WebRTC is point-to-point while a
 * host can have several: the host sends `{ peer: <clientId>, … }` and the relay
 * routes it to that one client; a client sends no `peer`, and the relay stamps
 * the sender's id as `peer` before handing it to the host. (The same shape the
 * paint stream proved.)
 */
export interface Signal {
  type: "signal";
  /** Target viewer id (host→client); stamped by the relay on client→host. */
  peer?: string;
  data: unknown;
}

/** Why there is no video, so the iPad can say so instead of showing a black rectangle. */
export type CaptureState = "idle" | "active" | "needsGesture" | "denied";

export interface VideoStatus {
  type: "videoStatus";
  state: CaptureState;
  /** The upstream failure verbatim, when there is one. Diagnostics for the human. */
  detail?: string;
}

// ── session plumbing (relay-level) ─────────────────────────────────────────
//
// Note what is NOT here: the command bar. Per D5 it is its own channel — its own
// sidecar, socket, and package (`aiui-remote-bar`) — so a bar-only remote exists
// without the pencil, and this wire carries ink and its view plane, nothing else.

export interface SessionInfo {
  id: string;
  label: string;
  project?: string;
  /** The aiui channel this host belongs to, when it declared one. */
  channelTag?: string;
  busy: boolean;
  connectedAt: string;
}

/** iPad client → relay. */
export type ClientToRelay = { type: "join"; host: string } | { type: "leave" } | InkIntent | Signal;

/** relay → iPad client. */
export type RelayToClient =
  | { type: "sessions"; sessions: SessionInfo[] }
  | { type: "joined"; host: string; label: string }
  | { type: "joinRejected"; reason: string }
  | { type: "hostGone" }
  | VideoStatus
  | Signal;

/** browser host → relay. */
export type HostToRelay =
  | { type: "register"; label: string; project?: string; channelPort?: number }
  | VideoStatus
  | Signal;

/** relay → browser host. */
export type RelayToHost =
  | { type: "registered"; id: string }
  | { type: "clientJoined"; client: string }
  | { type: "clientLeft"; client: string }
  | InkIntent
  | Signal;

export type WireMessage = ClientToRelay | RelayToClient | HostToRelay | RelayToHost;

// ── coordinates ────────────────────────────────────────────────────────────

/** The surface a normalized point is being mapped onto (CSS px). */
export interface Surface {
  width: number;
  height: number;
}

/**
 * Canvas sample → wire point. The inverse of {@link fromNorm} on position; the
 * instrument's other channels ride along untouched.
 *
 * A degenerate surface (zero width or height — a canvas that has not been laid
 * out yet) maps to 0 rather than NaN: a stroke drawn into a not-yet-sized canvas
 * should land at the origin, not poison every downstream number.
 */
export function toNorm(sample: PenSample, surface: Surface): WirePoint {
  const point: WirePoint = {
    u: surface.width > 0 ? sample.x / surface.width : 0,
    v: surface.height > 0 ? sample.y / surface.height : 0,
    t: sample.t,
  };
  if (sample.kind !== "mouse" || sample.pressure !== 0) {
    point.p = sample.pressure;
  }
  point.alt = sample.altitude;
  point.az = sample.azimuth;
  return point;
}

/**
 * Wire point → canvas sample, against *this* endpoint's surface. This is the
 * whole reason coordinates are normalized: the iPad and the host disagree about
 * pixels, and neither has to know the other's.
 */
export function fromNorm(point: WirePoint, surface: Surface, kind: PointerKind = "pen"): PenSample {
  return {
    x: point.u * surface.width,
    y: point.v * surface.height,
    t: point.t,
    pressure: point.p ?? (kind === "pen" ? 0.5 : 0),
    // An absent altitude is not an error and not a special case: it is a pen held
    // upright, which is exactly what a mouse or a finger is. The instrument
    // degrades by geometry, not by branch.
    altitude: point.alt ?? Math.PI / 2,
    azimuth: point.az ?? 0,
    twist: 0,
    kind,
    width: 0,
    height: 0,
  };
}

// ── framing ────────────────────────────────────────────────────────────────

export function encode(message: WireMessage): string {
  return JSON.stringify(message);
}

/**
 * Parse a text frame. Returns `undefined` for anything that is not a JSON object
 * with a string `type` — a malformed frame is dropped, never thrown: one bad
 * message from one client must not take down a relay serving others.
 */
export function decode(raw: string): WireMessage | undefined {
  try {
    const value: unknown = JSON.parse(raw);
    if (
      typeof value === "object" &&
      value !== null &&
      typeof (value as { type?: unknown }).type === "string"
    ) {
      return value as WireMessage;
    }
  } catch {
    // fall through
  }
  return undefined;
}
