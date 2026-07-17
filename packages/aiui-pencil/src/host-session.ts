/**
 * host-session.ts — the host side of the remote pencil, as a consumable.
 *
 * Everything between "I have a `PencilSurface` and something capturable" and
 * "iPads can draw on it": the relay websocket (with reconnect), the
 * `RemoteHost` core, one `RTCPeerConnection` per viewer, offer/ICE ferrying
 * through the relay's addressed `signal` frames, the capture keepalive, and
 * `videoStatus` so no viewer ever stares at unexplained black.
 *
 * This was extracted from the Lab's host wiring so that INTEGRATORS never
 * touch WebRTC: the whole paint-era `paint-host.ts` (capture → JPEG pump →
 * websocket) is replaced by constructing one of these with a surface and a
 * stream. The Lab remains the living reference consumer.
 *
 * The one contract that carries all the coordinate correctness (D2): the
 * plane reported by {@link HostSessionOptions.size} must be **the captured
 * frame** — the same rectangle the stream shows. For a canvas plane that is
 * the canvas itself (same element, trivially equal). For a tab plane it is the
 * viewport *including any classic scrollbar strips* — a fixed overlay sized
 * `100%` excludes them while the capture includes them, and every stroke lands
 * compressed by the sliver ratio (measured before this was understood: sent
 * u = 0.45, landed 0.4436 = 0.45 × 1035/1050). Size the overlay `100vw/100vh`
 * and report its own size, and the frames cannot disagree.
 */

import type { PencilMode, PencilParams } from "./pencil";
import {
  decode,
  encode,
  type HostToRelay,
  type RelayToHost,
  type RemotePresentation,
  type Surface,
} from "./protocol";
import { RemoteHost } from "./remote";
import type { PencilSurface } from "./surface";

export interface HostSessionStatus {
  /** The relay connection: down, dialing, or registered-and-listed. */
  state: "off" | "connecting" | "hosting";
  viewers: number;
  /** Is a media stream currently in hand for the plane? */
  capturing: boolean;
}

export interface HostSessionOptions {
  /**
   * The relay's host endpoint, e.g. `ws://127.0.0.1:<port>/pencil/host`.
   * Same-origin pages can build it with {@link hostRelayUrl}.
   */
  url: string;
  /** Shown in every client's session list. */
  label: string;
  /** How the remote client should present this session (see the protocol). */
  presentation?: RemotePresentation;
  /** The surface remote strokes land on. Read per message — planes may switch. */
  surface: () => PencilSurface;
  /**
   * The plane, in CSS px — **must equal the captured frame** (see the module
   * doc). Defaults to `surface().size()`, which is exactly right for a canvas
   * plane and right for a tab plane whose overlay spans the full viewport.
   */
  size?: () => Surface;
  /** The brush resolver — the host owns the brush. Defaults to the shipped presets. */
  params?: (mode: PencilMode) => PencilParams;
  /**
   * The current plane's media stream, or `undefined` while there is none (a tab
   * plane before its click-gated grant). Viewers joining during `undefined` are
   * remembered and offered as soon as {@link HostSession.refresh} says otherwise.
   */
  stream: () => MediaStream | undefined;
  /** Why there is no stream yet — the `videoStatus: needsGesture` detail. */
  streamHint?: () => string | undefined;
  /**
   * Called at ~2 Hz while viewers are connected. A `captureStream()` canvas
   * emits frames only when it repaints and a still surface deliberately never
   * does — pass `() => paper.repaint()` for a canvas plane; omit for a tab
   * plane (display capture paces itself).
   */
  keepWarm?: () => void;
  /** Navigation intents from viewers. What they MEAN belongs to the app. */
  onScroll?: (du: number, dv: number) => void;
  onZoom?: (centerU: number, centerV: number, scale: number) => void;
  /** Status snapshots, on every change. Bridge into a signal at the app edge. */
  onStatus?: (status: HostSessionStatus) => void;
}

const RECONNECT_MS = 2000;
const KEEP_WARM_MS = 500;

export class HostSession {
  private ws: WebSocket | undefined;
  private core: RemoteHost | undefined;
  private peers = new Map<string, RTCPeerConnection | null>();
  private stopped = false;
  private state: HostSessionStatus["state"] = "off";
  private reconnect: ReturnType<typeof setTimeout> | undefined;
  private warm: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly opts: HostSessionOptions) {}

  /** Dial the relay. Reconnects every {@link RECONNECT_MS} until disposed. */
  connect(): void {
    this.stopped = false;
    const ws = new WebSocket(this.opts.url);
    this.ws = ws;
    this.publish("connecting");

    const core = new RemoteHost({
      send: (message) => this.send(message),
      surface: () => this.opts.surface(),
      size: () => this.opts.size?.() ?? this.opts.surface().size(),
      ...(this.opts.params ? { params: this.opts.params } : {}),
      onSignal: (peer, data) => {
        if (peer !== undefined) {
          void this.onSignal(peer, data);
        }
      },
      ...(this.opts.onScroll ? { onScroll: this.opts.onScroll } : {}),
      ...(this.opts.onZoom ? { onZoom: this.opts.onZoom } : {}),
    });
    this.core = core;

    ws.addEventListener("open", () => {
      this.send({
        type: "register",
        label: this.opts.label,
        ...(this.opts.presentation !== undefined ? { presentation: this.opts.presentation } : {}),
      });
      this.pushVideoStatus();
      this.publish("hosting");
    });

    ws.addEventListener("message", (event) => {
      if (typeof event.data !== "string") {
        return;
      }
      const message = decode(event.data) as RelayToHost | undefined;
      if (!message) {
        return;
      }
      if (message.type === "clientJoined") {
        void this.addViewer(message.client);
        return;
      }
      if (message.type === "clientLeft") {
        this.dropViewer(message.client);
        return;
      }
      core.receive(message);
    });

    ws.addEventListener("close", () => {
      for (const id of [...this.peers.keys()]) {
        this.dropViewer(id);
      }
      this.publish("off");
      if (!this.stopped) {
        this.reconnect = setTimeout(() => this.connect(), RECONNECT_MS);
      }
    });
    ws.addEventListener("error", () => ws.close());
  }

  /**
   * The plane changed — a different stream, a granted capture, a mode switch.
   * Announces the new `videoStatus` and re-offers to every connected viewer
   * (clients treat any incoming SDP as a fresh offer and rebuild their side).
   */
  refresh(): void {
    this.pushVideoStatus();
    this.publish();
    for (const id of [...this.peers.keys()]) {
      void this.addViewer(id);
    }
  }

  /** A capture attempt failed — tell every viewer why, verbatim. */
  deny(detail: string): void {
    this.send({ type: "videoStatus", state: "denied", detail });
    this.publish();
  }

  dispose(): void {
    this.stopped = true;
    clearTimeout(this.reconnect);
    clearInterval(this.warm);
    this.warm = undefined;
    this.ws?.close();
    for (const id of [...this.peers.keys()]) {
      this.dropViewer(id);
    }
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private send(message: HostToRelay): void {
    if (this.ws && this.ws.readyState === this.ws.OPEN) {
      this.ws.send(encode(message));
    }
  }

  private pushVideoStatus(): void {
    if (this.opts.stream()) {
      this.send({ type: "videoStatus", state: "active" });
    } else {
      const detail = this.opts.streamHint?.();
      this.send({
        type: "videoStatus",
        state: "needsGesture",
        ...(detail ? { detail } : {}),
      });
    }
  }

  private keepalive(): void {
    const wanted = this.peers.size > 0 && this.opts.keepWarm !== undefined;
    if (wanted && this.warm === undefined) {
      this.warm = setInterval(() => this.opts.keepWarm?.(), KEEP_WARM_MS);
    } else if (!wanted && this.warm !== undefined) {
      clearInterval(this.warm);
      this.warm = undefined;
    }
  }

  private async addViewer(peer: string): Promise<void> {
    const stream = this.opts.stream();
    if (!stream) {
      // No capture yet (a tab plane before its grant): remember the viewer —
      // the join-time videoStatus replay already told it why — and offer when
      // refresh() says the stream exists.
      this.peers.get(peer)?.close();
      this.peers.set(peer, null);
      this.publish();
      return;
    }
    this.peers.get(peer)?.close();
    const pc = new RTCPeerConnection();
    this.peers.set(peer, pc);
    this.keepalive();
    this.publish();

    for (const track of stream.getTracks()) {
      pc.addTrack(track, stream);
    }
    pc.onicecandidate = (e) => {
      if (e.candidate) {
        this.core?.signal(peer, { candidate: e.candidate.toJSON() });
      }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this.core?.signal(peer, { sdp: pc.localDescription });
  }

  private dropViewer(peer: string): void {
    this.peers.get(peer)?.close();
    this.peers.delete(peer);
    this.keepalive();
    this.publish();
  }

  private async onSignal(peer: string, data: unknown): Promise<void> {
    const pc = this.peers.get(peer);
    if (!pc) {
      return;
    }
    const payload = data as {
      sdp?: RTCSessionDescriptionInit;
      candidate?: RTCIceCandidateInit;
    };
    try {
      if (payload.sdp) {
        await pc.setRemoteDescription(payload.sdp);
      } else if (payload.candidate) {
        await pc.addIceCandidate(payload.candidate);
      }
    } catch {
      // A viewer racing its own teardown can signal a dead connection; that is
      // its problem, not the host page's.
    }
  }

  private publish(state?: HostSessionStatus["state"]): void {
    if (state !== undefined) {
      this.state = state;
    }
    this.opts.onStatus?.({
      state: this.state,
      viewers: this.peers.size,
      capturing: this.opts.stream() !== undefined,
    });
  }
}

/** The host endpoint on this page's own origin (the Lab, or a channel page). */
export function hostRelayUrl(prefix = "/pencil", loc: Location = window.location): string {
  const scheme = loc.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${loc.host}${prefix}/host`;
}

/** The client endpoint on this page's own origin. */
export function clientRelayUrl(prefix = "/pencil", loc: Location = window.location): string {
  const scheme = loc.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${loc.host}${prefix}/client`;
}
