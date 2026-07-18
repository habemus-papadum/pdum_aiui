/**
 * backend.ts — the pencil relay as a **host-neutral backend**.
 *
 * The room that pairs a browser **host** (the page that owns the real
 * `PencilSurface`) with remote **clients** (the iPad). The room mechanics —
 * register / join / leave / sessions / heartbeat / join-replay — live in the
 * shared `@habemus-papadum/aiui-room-relay` core; this file is the pencil
 * **vocabulary delegate** over it: what a register contributes, and how the
 * pencil wire's frames route.
 *
 * What the relay forwards, and — more telling — what it does not:
 *
 *   client → host   ink intents (strokes, undo/clear, scroll/zoom), and
 *                   `signal` frames stamped with the sender's id
 *   host → client   `videoStatus` (broadcast, and cached for join replay — a
 *                   joining client must know WHY there is no picture, not stare
 *                   at black), and `signal` frames routed to their one `peer`
 *
 * **No media.** Video is a `MediaStreamTrack` on an `RTCPeerConnection` between
 * the host and the client directly (D1); the relay carries only its signaling.
 *
 * It never listens on a port itself: the two seams (an HTTP handler and a
 * websocket-upgrade handler) are mounted by a host process. The channel sidecar
 * (`./sidecar`) mounts it at `/pencil`; the Lab's Vite plugin mounts the same
 * backend into the dev server, which is how the whole loop runs with no channel.
 *
 * Routes (all under {@link PencilBackendOptions.prefix}, default ``):
 *   GET  <prefix>/info      readiness + counts, JSON (CORS — probes read it)
 *   GET  <prefix>/health    liveness + counts, JSON
 *   GET  <prefix>/sessions  the connectable hosts, JSON
 *   WS   <prefix>/host      a browser host (owns the surface and the capture)
 *   WS   <prefix>/client    a remote (the iPad app, or the Lab's test client)
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import {
  type Assignable,
  type ChannelResolver,
  createRoomRelayBackend,
  type RoomServerFrame,
} from "@habemus-papadum/aiui-room-relay";
import { decode, encode, isInkIntent, type SessionInfo, type WireMessage } from "./protocol";

/** Maps a channel web-backend port to its session, for enriching host info. */
export type { ChannelResolver };

export interface PencilBackendOptions {
  /** Path prefix all routes live under (e.g. `"/pencil"`). Default: none. */
  prefix?: string;
  /** Static session identity hosts inherit when they don't announce their own. */
  session?: { project?: string; channelTag?: string };
  /** Resolve a host-announced channel port to `{ tag, project }`. */
  resolveChannel?: ChannelResolver;
  /** Line logger for lifecycle diagnostics (defaults to silent). */
  log?: (line: string) => void;
}

export interface PencilBackend {
  /** Handle an HTTP request for a pencil route. Returns true if handled. */
  handleHttp(req: IncomingMessage, res: ServerResponse): boolean;
  /** Handle a websocket upgrade for `<prefix>/host` or `<prefix>/client`. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean;
  /** The currently connectable hosts. */
  sessions(): SessionInfo[];
  /** Live connection counts (for info routes + tests). */
  counts(): { hosts: number; clients: number };
  /** Close every connection and stop the heartbeat. */
  dispose(): void;
}

export function createPencilBackend(options: PencilBackendOptions = {}): PencilBackend {
  // The `Assignable` argument still resolves `M` to `WireMessage`, while proving
  // the relay core's server frames are all valid on this wire (its cast is sound).
  return createRoomRelayBackend<Assignable<WireMessage, RoomServerFrame>>({
    prefix: options.prefix,
    session: options.session,
    resolveChannel: options.resolveChannel,
    log: options.log,
    logPrefix: "pencil",
    decode,
    encode,
    // A host declares how it wants its remote PRESENTED; the pencil wire ignores
    // a `channelTag` on register (unlike the bar), so only presentation carries.
    registerExtras: (message) =>
      message.type === "register" && message.presentation !== undefined
        ? { presentation: message.presentation }
        : {},
    joinedExtras: (info) => {
      const presentation = (info as SessionInfo).presentation;
      return presentation !== undefined ? { presentation } : {};
    },
    onHostMessage: (message, { cacheForReplay, sendToClient }) => {
      if (message.type === "videoStatus") {
        // Cache for join-time replay, then fan out: every viewer deserves to
        // know why there is (or is not) a picture.
        cacheForReplay(message);
        return;
      }
      if (message.type === "signal") {
        // WebRTC is point-to-point: a host's offer/ICE goes to ONE viewer.
        sendToClient(message.peer, message);
      }
    },
    onClientMessage: (message, { clientId, sendToHost }) => {
      if (isInkIntent(message)) {
        sendToHost(message);
        return;
      }
      if (message.type === "signal") {
        // Stamp the sender: the host must know WHICH peer connection this
        // answer/candidate belongs to, and the client cannot be trusted to say.
        sendToHost({ ...message, peer: clientId });
      }
    },
  });
}
