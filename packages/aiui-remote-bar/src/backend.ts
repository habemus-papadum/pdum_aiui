/**
 * backend.ts — the remote-bar coordinator as a **host-neutral backend**.
 *
 * The room that pairs a browser **host** (the page that owns the mode engine)
 * with **remote** clients — relay the bar down, commands up. The room mechanics —
 * register / join / leave / sessions / heartbeat, plus the join-replay that
 * caches each host's **last bar** so a remote joining an idle host still paints a
 * bar instead of a blank surface — live in the shared
 * `@habemus-papadum/aiui-room-relay` core; this file is the bar **vocabulary
 * delegate** over it.
 *
 * The wire carries only JSON control frames (`bar` down, `command` up) — no
 * binary, no video, no WebRTC signaling. It never listens on a port itself: the
 * two seams (an HTTP handler and a websocket-upgrade handler) are mounted by a
 * host process. The channel sidecar (`./sidecar`) mounts it at `/bar` on the aiui
 * channel's one server.
 *
 * Routes (all under {@link BarBackendOptions.prefix}, default ``):
 *   GET  <prefix>/info      readiness + counts, JSON (CORS — probes read it)
 *   GET  <prefix>/health    liveness + counts, JSON
 *   GET  <prefix>/sessions  the connectable hosts, JSON
 *   WS   <prefix>/host      a browser host (owns the mode engine)
 *   WS   <prefix>/client    a remote (the bar-only client, or the pencil iPad app)
 *
 * There is deliberately **no HTML route** — the channel serves no pages, and the
 * bar's client is a frontend-process Solid component (`./ui`), not a page the
 * relay hands out (pencil's `/pencil/` page is the one documented exception, for
 * an iPad with no frontend process; a bar remote is an ordinary app).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import {
  type Assignable,
  type ChannelResolver,
  createRoomRelayBackend,
  type RoomServerFrame,
} from "@habemus-papadum/aiui-room-relay";
import { decode, encode, isRemoteCommand, type SessionInfo, type WireMessage } from "./protocol";

/** Maps a channel web-backend port to its session, for enriching host info. */
export type { ChannelResolver };

export interface BarBackendOptions {
  /** Path prefix all routes live under (e.g. `"/bar"`). Default: none. */
  prefix?: string;
  /**
   * Static session identity every host registered here inherits when it doesn't
   * announce its own — the channel sidecar passes its project root, so the
   * remote's list shows which session a host belongs to.
   */
  session?: { project?: string; channelTag?: string };
  /**
   * Resolve a host-announced channel port to `{ tag, project }` (multi-session
   * deployments). No default — the single-session sidecar uses {@link session}.
   */
  resolveChannel?: ChannelResolver;
  /** Line logger for lifecycle diagnostics (defaults to silent). */
  log?: (line: string) => void;
}

export interface BarBackend {
  /** Handle an HTTP request for a bar route. Returns true if handled. */
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

export function createBarBackend(options: BarBackendOptions = {}): BarBackend {
  // The `Assignable` argument still resolves `M` to `WireMessage`, while proving
  // the relay core's server frames are all valid on this wire (its cast is sound).
  return createRoomRelayBackend<Assignable<WireMessage, RoomServerFrame>>({
    prefix: options.prefix,
    session: options.session,
    resolveChannel: options.resolveChannel,
    log: options.log,
    logPrefix: "bar",
    decode,
    encode,
    // The bar wire carries a `channelTag` on register (unlike the pencil); the
    // channelPort → registry resolution below preserves it via `??`.
    registerExtras: (message) =>
      message.type === "register" && message.channelTag ? { channelTag: message.channelTag } : {},
    onHostMessage: (message, { cacheForReplay }) => {
      if (message.type === "bar") {
        // Cache for join-time replay, then fan out to current viewers.
        cacheForReplay(message);
      }
    },
    onClientMessage: (message, { sendToHost }) => {
      // A bar tap → the host, which dispatches it into the mode engine.
      if (isRemoteCommand(message)) {
        sendToHost(message);
      }
    },
  });
}
