/**
 * backend.ts — the pencil relay as a **host-neutral backend**.
 *
 * The room logic that pairs a browser **host** (the page that owns the real
 * `PencilSurface`) with remote **clients** (the iPad), packaged as the two seams
 * the repo's relays share (`aiui-remote-bar`, and retired `aiui-paint` before it): an
 * HTTP handler and a websocket-upgrade handler that a host process mounts
 * wherever it likes. It never listens on a port itself. The channel sidecar
 * (`./sidecar`) mounts it at `/pencil`; the Lab's Vite plugin mounts the same
 * backend into the dev server, which is how the whole loop runs with no channel.
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
 * That is the deliberate difference from the paint relay this replaced, whose
 * whole job was pumping JPEG frames — this one moves a few JSON frames a second
 * and then gets out of the way.
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
import { type WebSocket, WebSocketServer } from "ws";
import {
  decode,
  encode,
  isInkIntent,
  type SessionInfo,
  type VideoStatus,
  type WireMessage,
} from "./protocol";

/** Maps a channel web-backend port to its session, for enriching host info. */
export type ChannelResolver = (port: number) => { tag: string; project: string } | undefined;

/** Ping cadence; a socket that misses one full interval is terminated. */
const HEARTBEAT_MS = 30_000;

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

interface HostConn {
  id: string;
  ws: WebSocket;
  info: SessionInfo;
  registered: boolean;
  /** The last capture state — replayed on join, so no client stares at black. */
  lastVideoStatus: VideoStatus | undefined;
  /** Clients of this host, keyed by client id. */
  clients: Map<string, ClientConn>;
}

interface ClientConn {
  id: string;
  ws: WebSocket;
  host: HostConn | undefined;
}

/** Parse a request-target, or undefined for a malformed one — never throw (an
 * exception here would surface in the HOST process's request/upgrade path). */
function parseRequestUrl(raw: string | undefined): URL | undefined {
  try {
    return new URL(raw ?? "/", "http://localhost");
  } catch {
    return undefined;
  }
}

/** Send a JSON control frame if the socket is open. */
function send(ws: WebSocket, message: WireMessage): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(encode(message));
  }
}

export function createPencilBackend(options: PencilBackendOptions = {}): PencilBackend {
  const prefix = options.prefix ?? "";
  const log = options.log ?? (() => {});
  const hosts = new Map<string, HostConn>();
  const clients = new Set<ClientConn>();
  let hostSeq = 0;
  let clientSeq = 0;

  const sessions = (): SessionInfo[] =>
    [...hosts.values()].filter((h) => h.registered).map((h) => ({ ...h.info }));

  const broadcastSessions = (): void => {
    const list = sessions();
    for (const client of clients) {
      send(client.ws, { type: "sessions", sessions: list });
    }
  };

  // ── heartbeat: terminate sockets that miss a full ping interval ─────────────
  const alive = new WeakMap<WebSocket, boolean>();
  const track = (ws: WebSocket): void => {
    alive.set(ws, true);
    ws.on("pong", () => alive.set(ws, true));
  };
  const heartbeat = setInterval(() => {
    for (const conn of [...hosts.values(), ...clients]) {
      const ws = conn.ws;
      if (ws.readyState !== ws.OPEN) {
        continue;
      }
      if (alive.get(ws) === false) {
        ws.terminate(); // close events run the normal leave/cleanup paths
        continue;
      }
      alive.set(ws, false);
      try {
        ws.ping();
      } catch {
        // socket died between the check and the ping — terminate next round
      }
    }
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  // ── websocket endpoints (noServer; the host process forwards upgrades) ──────
  const hostWss = new WebSocketServer({ noServer: true });
  const clientWss = new WebSocketServer({ noServer: true });

  hostWss.on("connection", (ws) => {
    const id = `host-${++hostSeq}`;
    const conn: HostConn = {
      id,
      ws,
      registered: false,
      lastVideoStatus: undefined,
      clients: new Map(),
      info: {
        id,
        label: "app",
        busy: false,
        connectedAt: new Date().toISOString(),
        ...(options.session?.project ? { project: options.session.project } : {}),
        ...(options.session?.channelTag ? { channelTag: options.session.channelTag } : {}),
      },
    };
    hosts.set(id, conn);
    track(ws);
    send(ws, { type: "registered", id });

    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        return; // no media on this wire (D1) — video is peer-to-peer
      }
      const message = decode(data.toString());
      if (!message) {
        return;
      }
      if (message.type === "register") {
        conn.info.label = message.label || "app";
        if (message.project) {
          conn.info.project = message.project;
        }
        if (message.presentation !== undefined) {
          conn.info.presentation = message.presentation;
        }
        if (message.channelPort !== undefined && options.resolveChannel) {
          const resolved = options.resolveChannel(message.channelPort);
          if (resolved) {
            conn.info.channelTag = conn.info.channelTag ?? resolved.tag;
            conn.info.project = conn.info.project ?? resolved.project;
          }
        }
        conn.registered = true;
        log(`pencil: host "${conn.info.label}" registered (${hosts.size} host(s))`);
        broadcastSessions();
        return;
      }
      if (message.type === "videoStatus") {
        // Cache for join-time replay, then fan out: every viewer deserves to
        // know why there is (or is not) a picture.
        conn.lastVideoStatus = message;
        for (const client of conn.clients.values()) {
          send(client.ws, message);
        }
        return;
      }
      if (message.type === "signal") {
        // WebRTC is point-to-point: a host's offer/ICE goes to ONE viewer.
        const target = message.peer === undefined ? undefined : conn.clients.get(message.peer);
        if (target) {
          send(target.ws, message);
        }
      }
    });

    ws.on("close", () => {
      hosts.delete(id);
      for (const client of conn.clients.values()) {
        client.host = undefined;
        send(client.ws, { type: "hostGone" });
      }
      conn.clients.clear();
      broadcastSessions();
    });
    ws.on("error", () => {});
  });

  clientWss.on("connection", (ws) => {
    const conn: ClientConn = { id: `client-${++clientSeq}`, ws, host: undefined };
    clients.add(conn);
    track(ws);
    send(ws, { type: "sessions", sessions: sessions() });

    const leaveRoom = (): void => {
      const host = conn.host;
      if (!host) {
        return;
      }
      host.clients.delete(conn.id);
      conn.host = undefined;
      host.info.busy = host.clients.size > 0;
      send(host.ws, { type: "clientLeft", client: conn.id });
      broadcastSessions();
    };

    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        return;
      }
      const message = decode(data.toString());
      if (!message) {
        return;
      }
      if (message.type === "join") {
        leaveRoom();
        const host = hosts.get(message.host);
        if (!host?.registered) {
          send(ws, { type: "joinRejected", reason: "host not found" });
          return;
        }
        conn.host = host;
        host.clients.set(conn.id, conn);
        host.info.busy = true;
        send(ws, {
          type: "joined",
          host: host.id,
          label: host.info.label,
          ...(host.info.presentation !== undefined ? { presentation: host.info.presentation } : {}),
        });
        // Join replay: the capture state is event-driven, so a quiet host would
        // otherwise leave a new viewer staring at black with no explanation.
        if (host.lastVideoStatus) {
          send(ws, host.lastVideoStatus);
        }
        // The host starts the WebRTC dance on this: new viewer → new offer.
        send(host.ws, { type: "clientJoined", client: conn.id });
        broadcastSessions();
        return;
      }
      if (message.type === "leave") {
        leaveRoom();
        return;
      }
      if (!conn.host) {
        return;
      }
      if (isInkIntent(message)) {
        send(conn.host.ws, message);
        return;
      }
      if (message.type === "signal") {
        // Stamp the sender: the host must know WHICH peer connection this
        // answer/candidate belongs to, and the client cannot be trusted to say.
        send(conn.host.ws, { ...message, peer: conn.id });
      }
    });

    ws.on("close", () => {
      leaveRoom();
      clients.delete(conn);
    });
    ws.on("error", () => {});
  });

  // ── the host-neutral seams ───────────────────────────────────────────────────
  const sendJson = (res: ServerResponse, body: unknown): void => {
    res.statusCode = 200;
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(body));
  };

  const handleHttp = (req: IncomingMessage, res: ServerResponse): boolean => {
    const url = parseRequestUrl(req.url);
    if (!url) {
      return false;
    }
    if ((req.method ?? "GET") !== "GET") {
      return false;
    }
    if (url.pathname === `${prefix}/info` || url.pathname === `${prefix}/health`) {
      sendJson(res, { ok: true, ...counts() });
      return true;
    }
    if (url.pathname === `${prefix}/sessions`) {
      sendJson(res, { sessions: sessions() });
      return true;
    }
    return false;
  };

  const handleUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): boolean => {
    const url = parseRequestUrl(req.url);
    if (!url) {
      return false;
    }
    if (url.pathname === `${prefix}/host`) {
      hostWss.handleUpgrade(req, socket, head, (ws) => hostWss.emit("connection", ws, req));
      return true;
    }
    if (url.pathname === `${prefix}/client`) {
      clientWss.handleUpgrade(req, socket, head, (ws) => clientWss.emit("connection", ws, req));
      return true;
    }
    return false;
  };

  const counts = (): { hosts: number; clients: number } => ({
    hosts: hosts.size,
    clients: clients.size,
  });

  const dispose = (): void => {
    clearInterval(heartbeat);
    for (const conn of hosts.values()) {
      conn.ws.close();
    }
    for (const conn of clients) {
      conn.ws.close();
    }
    clientWss.close();
    hostWss.close();
  };

  return { handleHttp, handleUpgrade, sessions, counts, dispose };
}
