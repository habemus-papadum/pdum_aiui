/**
 * client-session.ts — the viewer side of the remote pencil, as a consumable.
 *
 * Everything between "I have a `<video>` and a place the pen draws" and "my
 * strokes land on the host": the relay websocket, the `RemoteClient` core, the
 * answering `RTCPeerConnection` (the host offers; this side answers), ICE
 * ferrying, and the connection-state bookkeeping that un-hides the status note
 * instead of freezing on a stale frame when the host re-plans its capture.
 *
 * What it deliberately does NOT own — because these are where apps differ:
 *
 *  - the **plane geometry** ({@link ClientSessionOptions.surface}): the app
 *    computes the video's content box (letterboxing!) and normalizes against
 *    it — see the Lab client's `recomputePlane` for the worked example, and
 *    the hard-won rule that it must track the video element's own `resize`
 *    events (WebRTC ramps resolution from a tiny first frame);
 *  - the **preview** rendering and its D3 crossfade (a `PencilSurface` with
 *    `fadeCurve: "crossfade"`);
 *  - the **pen state machine** (pencil-mode latch, palm rejection, two-finger
 *    navigation) — input policy, not transport.
 */

import type { PencilMode } from "./pencil";
import {
  type ClientToRelay,
  decode,
  encode,
  type PointerKind,
  type RelayToClient,
  type RemotePresentation,
  type SessionInfo,
  type StrokeOverrides,
  type Surface,
  type VideoStatus,
} from "./protocol";
import type { LinkStats } from "./remote";
import { RemoteClient } from "./remote";
import type { Tool } from "./surface";
import type { PenSample } from "./telemetry";

export interface ClientSessionOptions {
  /**
   * The relay's client endpoint, e.g. `ws://<mac>:<port>/pencil/client`.
   * Same-origin pages can build it with `clientRelayUrl()`.
   */
  url: string;
  /** The plane, CSS px — the video's CONTENT box, not its element box. */
  surface: () => Surface;
  /** The instrument, as this client currently holds it. */
  tool: () => Tool;
  mode: () => PencilMode;
  /** The user's brush knobs, when the joined host's presentation offers them. */
  overrides?: () => StrokeOverrides | undefined;
  /** Where the host's track lands. Read when the offer arrives. */
  video: () => HTMLVideoElement | undefined;
  onSessions?: (sessions: SessionInfo[]) => void;
  onJoined?: (host: string, label: string, presentation?: RemotePresentation) => void;
  onJoinRejected?: (reason: string) => void;
  onHostGone?: () => void;
  onVideoStatus?: (status: VideoStatus) => void;
  /** The track is attached and (dis)connected — drive "waiting…" chrome. */
  onVideoUp?: () => void;
  onVideoDown?: () => void;
  onClose?: () => void;
}

export class ClientSession {
  private readonly ws: WebSocket;
  private readonly core: RemoteClient;
  private pc: RTCPeerConnection | undefined;

  constructor(private readonly opts: ClientSessionOptions) {
    this.ws = new WebSocket(opts.url);

    this.core = new RemoteClient({
      send: (message) => this.send(message),
      surface: opts.surface,
      tool: opts.tool,
      mode: opts.mode,
      ...(opts.overrides ? { overrides: opts.overrides } : {}),
      onSignal: (data) => void this.onSignal(data),
      ...(opts.onVideoStatus ? { onVideoStatus: opts.onVideoStatus } : {}),
      onHostGone: () => {
        this.pc?.close();
        this.pc = undefined;
        opts.onVideoDown?.();
        opts.onHostGone?.();
      },
    });

    this.ws.addEventListener("message", (event) => {
      if (typeof event.data !== "string") {
        return;
      }
      const message = decode(event.data) as RelayToClient | undefined;
      if (!message) {
        return;
      }
      switch (message.type) {
        case "sessions":
          this.opts.onSessions?.(message.sessions);
          return;
        case "joined":
          this.opts.onJoined?.(message.host, message.label, message.presentation);
          return;
        case "joinRejected":
          this.opts.onJoinRejected?.(message.reason);
          return;
        default:
          this.core.receive(message);
      }
    });
    this.ws.addEventListener("close", () => opts.onClose?.());
  }

  // ── rooms ──────────────────────────────────────────────────────────────────

  join(host: string): void {
    this.send({ type: "join", host });
  }

  leave(): void {
    this.send({ type: "leave" });
    this.pc?.close();
    this.pc = undefined;
    this.opts.onVideoDown?.();
  }

  // ── the pen (delegated to the tested core) ─────────────────────────────────

  begin(id: string, sample: PenSample, pointerType: PointerKind = "pen"): void {
    this.core.begin(id, sample, pointerType);
  }
  points(id: string, samples: readonly PenSample[]): void {
    this.core.points(id, samples);
  }
  end(id: string, sample?: PenSample): void {
    this.core.end(id, sample);
  }
  cancel(id: string): void {
    this.core.cancel(id);
  }
  undo(): void {
    this.core.undo();
  }
  clear(): void {
    this.core.clear();
  }
  scroll(du: number, dv: number): void {
    this.core.scroll(du, dv);
  }
  zoom(centerU: number, centerV: number, scale: number): void {
    this.core.zoom(centerU, centerV, scale);
  }

  /**
   * The receiver's measured delays, for `fadeWindowMs()` — D3's "a little more
   * scientific". Best-effort: every field is optional, and with no connection
   * this resolves to `undefined` (callers fall back to the shipped constant).
   */
  async stats(): Promise<LinkStats | undefined> {
    const pc = this.pc;
    if (!pc) {
      return undefined;
    }
    try {
      const report = await pc.getStats();
      const out: LinkStats = {};
      for (const entry of report.values()) {
        const s = entry as Record<string, unknown>;
        if (s.type === "candidate-pair" && s.state === "succeeded") {
          const rtt = s.currentRoundTripTime;
          if (typeof rtt === "number") {
            out.rttMs = rtt * 1000;
          }
        }
        if (s.type === "inbound-rtp" && s.kind === "video") {
          const delay = s.jitterBufferDelay;
          const count = s.jitterBufferEmittedCount;
          if (typeof delay === "number" && typeof count === "number" && count > 0) {
            out.jitterBufferMs = (delay / count) * 1000;
          }
          const fps = s.framesPerSecond;
          if (typeof fps === "number" && fps > 0) {
            out.frameIntervalMs = 1000 / fps;
          }
        }
      }
      return out;
    } catch {
      return undefined;
    }
  }

  dispose(): void {
    this.pc?.close();
    this.pc = undefined;
    this.ws.close();
  }

  // ── WebRTC: the host offers, this side answers ─────────────────────────────

  private send(message: ClientToRelay): void {
    if (this.ws.readyState === this.ws.OPEN) {
      this.ws.send(encode(message));
    }
  }

  private async onSignal(data: unknown): Promise<void> {
    const payload = data as {
      sdp?: RTCSessionDescriptionInit;
      candidate?: RTCIceCandidateInit;
    };
    if (payload.sdp) {
      // Any SDP from the host is a fresh offer (plane switches re-offer):
      // rebuild this side rather than trying to renegotiate a stale pair.
      this.pc?.close();
      const pc = new RTCPeerConnection();
      this.pc = pc;
      pc.onconnectionstatechange = () => {
        if (["disconnected", "failed", "closed"].includes(pc.connectionState)) {
          this.opts.onVideoDown?.();
        }
      };
      pc.ontrack = (e) => {
        const video = this.opts.video();
        if (video) {
          video.srcObject = e.streams[0] ?? new MediaStream([e.track]);
          this.opts.onVideoUp?.();
        }
      };
      pc.onicecandidate = (e) => {
        if (e.candidate) {
          this.send({ type: "signal", data: { candidate: e.candidate.toJSON() } });
        }
      };
      await pc.setRemoteDescription(payload.sdp);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this.send({ type: "signal", data: { sdp: pc.localDescription } });
      return;
    }
    if (payload.candidate && this.pc) {
      try {
        await this.pc.addIceCandidate(payload.candidate);
      } catch {
        // a candidate for a connection we already replaced — stale, not fatal
      }
    }
  }
}
