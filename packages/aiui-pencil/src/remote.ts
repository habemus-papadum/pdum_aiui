/**
 * remote.ts — the two endpoint cores: the wire's logic, with no socket in it.
 *
 * Neither class touches a websocket or an `RTCPeerConnection`: they take a
 * `send` callback and expose a `receive` method, so the whole protocol drives in
 * node, in a test, with no network and no DOM. The socket and the peer
 * connection are a page's worth of adapter in the app.
 *
 * ## The preview, and how it leaves (plan decision D3)
 *
 * The iPad draws each stroke locally — nothing over a network can feel
 * immediate otherwise — while the same stroke streams to the host and comes
 * back inside the WebRTC video. So, for the transit window, two copies of a
 * translucent stroke are on screen at once. The handoff policy is deliberately
 * the one the paint stream shipped and proved:
 *
 *   **from pen-up, the preview cross-fades out over a fixed window** —
 *   {@link PREVIEW_FADE_MS} by default — long enough that the video's copy has
 *   almost certainly arrived underneath before the preview is gone.
 *
 * There is no frame correlation, no ack, and no per-frame metadata (D3 records
 * why, including what the abandoned exact version would have cost). The one
 * refinement over paint v1 is that the window need not be a guess:
 * {@link fadeWindowMs} sizes it from the connection's *measured* delays when
 * `RTCRtpReceiver.getStats()` offers them, and falls back to the shipped
 * constant when it doesn't.
 */

import { type PencilMode, type PencilParams, resolveParams } from "./pencil";
import type {
  ClientToRelay,
  HostToRelay,
  InkIntent,
  PointerKind,
  RelayToClient,
  RelayToHost,
  Surface,
  VideoStatus,
  WirePoint,
} from "./protocol";
import { fromNorm, isInkIntent, toNorm } from "./protocol";
import type { PencilSurface, Tool } from "./surface";
import type { PenSample } from "./telemetry";

// ── the fade window ─────────────────────────────────────────────────────────

/**
 * Paint v1's shipped constant (`FADE_MS = 500` in its iPad client), kept as the
 * default because it is the one value with field evidence behind it.
 */
export const PREVIEW_FADE_MS = 500;

/** A fade shorter than this reads as flicker, not as a handoff. */
const MIN_FADE_MS = 300;
/** …and longer than this reads as a stroke that refuses to settle. */
const MAX_FADE_MS = 1500;
/** Encode + decode time that no receiver stat reports. A margin, honestly named. */
const CODEC_MARGIN_MS = 80;

/**
 * What can actually be measured about the link — all optional, because
 * `getStats()` is best-effort and every field of it doubly so.
 */
export interface LinkStats {
  /** Round-trip time, ms: candidate-pair `currentRoundTripTime` × 1000. */
  rttMs?: number;
  /** Mean jitter-buffer residence, ms: `jitterBufferDelay / jitterBufferEmittedCount` × 1000. */
  jitterBufferMs?: number;
  /** Frame interval, ms: 1000 / inbound-rtp `framesPerSecond`. */
  frameIntervalMs?: number;
}

/**
 * Size the preview fade from measured delays — D3's "a little more scientific".
 *
 * The estimate is the life of a pen-up stroke: the points ride up and the video
 * rides back (one full RTT between them), the capture can miss a frame and catch
 * the next (two frame intervals), the jitter buffer holds the frame for its
 * measured residence, and the codec takes its unreported margin. The window is
 * then **1.5× the estimate**, because the failure modes are not symmetric: a
 * preview that outlives the truth is a slightly darker stroke for 100 ms, while
 * a preview that dies first is a hole in the ink. Clamped, because a fade below
 * ~300 ms reads as flicker and one above ~1.5 s reads as broken.
 *
 * With no stats at all, this is exactly {@link PREVIEW_FADE_MS}.
 */
export function fadeWindowMs(stats?: LinkStats): number {
  if (
    stats === undefined ||
    (stats.rttMs === undefined &&
      stats.jitterBufferMs === undefined &&
      stats.frameIntervalMs === undefined)
  ) {
    return PREVIEW_FADE_MS;
  }
  const rtt = stats.rttMs ?? 60;
  const jitter = stats.jitterBufferMs ?? 60;
  const frame = stats.frameIntervalMs ?? 33;
  const estimate = rtt + jitter + 2 * frame + CODEC_MARGIN_MS;
  return Math.min(MAX_FADE_MS, Math.max(MIN_FADE_MS, Math.round(1.5 * estimate)));
}

// ── the iPad's endpoint ─────────────────────────────────────────────────────

export interface RemoteClientOptions {
  /** Put a message on the wire. */
  send: (message: ClientToRelay) => void;
  /** The preview canvas, in CSS px — what local coordinates are normalized against. */
  surface: () => Surface;
  /** The instrument, as the iPad currently holds it. */
  tool: () => Tool;
  mode: () => PencilMode;
  onVideoStatus?: (status: VideoStatus) => void;
  /** WebRTC signaling from the host — feed it straight to the peer connection. */
  onSignal?: (data: unknown) => void;
  onHostGone?: () => void;
}

/**
 * The iPad's endpoint: sends ink intent and ferries signaling. The command bar
 * is deliberately NOT here — per D5 it is its own channel (`aiui-remote-bar`),
 * and the iPad app simply connects to both.
 *
 * It holds no fade clock either: the *app's* preview surface owns the pixels, so
 * it owns their retirement too (alpha from `1 − (now − doneAt) / fadeWindowMs()`,
 * per frame, exactly as paint v1 did). This core's job ends at the wire.
 */
export class RemoteClient {
  constructor(private readonly opts: RemoteClientOptions) {}

  // ── local pen → the wire ────────────────────────────────────────────────

  begin(id: string, sample: PenSample, pointerType: PointerKind = "pen"): void {
    this.opts.send({
      type: "strokeBegin",
      id,
      pointerType,
      tool: this.opts.tool(),
      mode: this.opts.mode(),
      point: toNorm(sample, this.opts.surface()),
    });
  }

  points(id: string, samples: readonly PenSample[]): void {
    if (samples.length === 0) {
      return;
    }
    const surface = this.opts.surface();
    const points: WirePoint[] = samples.map((s) => toNorm(s, surface));
    this.opts.send({ type: "strokePoints", id, points });
  }

  end(id: string, sample?: PenSample): void {
    this.opts.send({
      type: "strokeEnd",
      id,
      ...(sample ? { point: toNorm(sample, this.opts.surface()) } : {}),
    });
  }

  cancel(id: string): void {
    this.opts.send({ type: "strokeCancel", id });
  }

  undo(): void {
    this.opts.send({ type: "undo" });
  }

  clear(): void {
    this.opts.send({ type: "clear" });
  }

  /** Two-finger pan: move the host's view by a fraction of the plane. */
  scroll(du: number, dv: number): void {
    this.opts.send({ type: "scroll", du, dv });
  }

  /** Pinch: multiply the host's zoom by `scale` about a normalized center. */
  zoom(centerU: number, centerV: number, scale: number): void {
    this.opts.send({ type: "zoom", centerU, centerV, scale });
  }

  /** Signaling for the peer connection (answers, ICE) — the relay stamps our id. */
  signal(data: unknown): void {
    this.opts.send({ type: "signal", data });
  }

  // ── the wire → the iPad ─────────────────────────────────────────────────

  receive(message: RelayToClient): void {
    switch (message.type) {
      case "videoStatus":
        this.opts.onVideoStatus?.(message);
        break;
      case "signal":
        this.opts.onSignal?.(message.data);
        break;
      case "hostGone":
        this.opts.onHostGone?.();
        break;
      default:
        break;
    }
  }
}

// ── the desktop's endpoint ──────────────────────────────────────────────────

export interface RemoteHostOptions {
  send: (message: HostToRelay) => void;
  /** The surface the remote strokes are drawn into — the host's own paper. */
  surface: () => PencilSurface;
  /** The host canvas in CSS px: what normalized coordinates are mapped onto. */
  size: () => Surface;
  /**
   * Resolve the brush for a stroke's declared mode. **The host owns the brush** —
   * the wire carries `mode`, not a parameter block, so a re-tuned preset takes
   * effect in one place and the iPad's preview and the host's ink cannot drift
   * apart per-stroke. Defaults to the shipped presets; the Lab passes its live
   * knobs, which is what lets a remote stroke be tuned by the sliders in front of
   * you while the iPad is drawing it.
   */
  params?: (mode: PencilMode) => PencilParams;
  /** A pan gesture: move the view by a fraction of the plane. The APP decides what that means. */
  onScroll?: (du: number, dv: number) => void;
  /** A pinch: multiply zoom by `scale` about a normalized center. */
  onZoom?: (centerU: number, centerV: number, scale: number) => void;
  /** Signaling from a viewer (`peer` is its relay-stamped id) — feed the peer connection. */
  onSignal?: (peer: string | undefined, data: unknown) => void;
}

/**
 * The desktop's endpoint: turns wire intent into strokes on the real surface and
 * ferries signaling. (The bar is its own channel — D5.)
 *
 * Note what it does **not** do: it never synthesizes pointer events. The iPad
 * sends *intent*, and the host's own `PencilSurface` renders it through exactly
 * the same path a local pen takes (`remoteBegin` / `remotePoint` / `remoteEnd`)
 * — which is what makes the two pencils literally the same pencil. Strokes
 * render **progressively**, point by point as they arrive: a viewer watching the
 * host must see ink appear as it is drawn (D3), not materialize at pen-up.
 */
export class RemoteHost {
  constructor(private readonly opts: RemoteHostOptions) {}

  receive(message: RelayToHost): void {
    if (isInkIntent(message)) {
      this.ink(message);
      return;
    }
    if (message.type === "signal") {
      this.opts.onSignal?.(message.peer, message.data);
    }
  }

  private ink(intent: InkIntent): void {
    const surface = this.opts.surface();
    const size = this.opts.size();
    switch (intent.type) {
      case "strokeBegin":
        surface.remoteBegin(intent.id, {
          tool: intent.tool,
          params: (this.opts.params ?? resolveParams)(intent.mode),
          point: fromNorm(intent.point, size, intent.pointerType),
        });
        break;
      case "strokePoints":
        for (const point of intent.points) {
          surface.remotePoint(intent.id, fromNorm(point, size));
        }
        break;
      case "strokeEnd":
        if (intent.point) {
          surface.remotePoint(intent.id, fromNorm(intent.point, size));
        }
        surface.remoteEnd(intent.id);
        break;
      case "strokeCancel":
        surface.remoteCancel(intent.id);
        break;
      case "undo":
        surface.undo();
        break;
      case "clear":
        surface.clear();
        break;
      case "scroll":
        this.opts.onScroll?.(intent.du, intent.dv);
        break;
      case "zoom":
        this.opts.onZoom?.(intent.centerU, intent.centerV, intent.scale);
        break;
      default:
        break;
    }
  }

  /** Signaling to one viewer (offers, ICE) — WebRTC is point-to-point, so it is addressed. */
  signal(peer: string, data: unknown): void {
    this.opts.send({ type: "signal", peer, data });
  }
}
