/**
 * backend.ts — the remote-bar coordinator as a **host-neutral backend**.
 *
 * This is the relay's room logic — pair a browser **host** (the page that owns
 * the mode engine) with **remote** clients, relay the bar down and commands up —
 * packaged the way `aiui-paint`'s backend is: two seams, an HTTP handler and a
 * websocket-upgrade handler, that a host process mounts wherever it likes. It
 * never listens on a port itself. The channel sidecar (`./sidecar`) mounts it at
 * `/bar` on the aiui channel's one server.
 *
 * It is the paint relay's room model **minus everything media** — no binary
 * frames, no video, no WebRTC signaling. The bar channel carries only JSON
 * control frames (`bar` down, `command` up). Two things it keeps from paint:
 *
 *  - **heartbeat** — a slept remote that never sent a FIN is ping-terminated, so
 *    a zombie viewer can't hold a room `busy` for the TCP timeout;
 *  - **channel-registry resolution** — a host that announces its `channelPort`
 *    gets its project + tag filled in, so the remote's session list shows which
 *    agent session each host belongs to.
 *
 * And one thing it adds, because the bar is **event-driven** where paint's video
 * is continuous: the relay caches each host's **last bar** and replays it to a
 * remote on join. Without it, a remote that joins an idle host (no dispatch since
 * it registered) would see a blank bar until the next commit — never, if the app
 * is quiet. Paint needs no such thing; its next frame is milliseconds away.
 *
 * Routes (all under {@link BarBackendOptions.prefix}, default ``):
 *   GET  <prefix>/info      readiness + counts, JSON (CORS — the overlay probes it)
 *   GET  <prefix>/health    liveness + counts, JSON
 *   GET  <prefix>/sessions  the connectable hosts, JSON
 *   WS   <prefix>/host      a browser host (owns the mode engine)
 *   WS   <prefix>/client    a remote (the bar-only client, or the pencil iPad app)
 *
 * There is deliberately **no HTML route** — the channel serves no pages, and the
 * bar's client is a frontend-process Solid component (`./ui`), not a page the
 * relay hands out (that is paint's one documented exception, for an iPad with no
 * frontend process; a bar remote is an ordinary app).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { type WebSocket, WebSocketServer } from "ws";
import {
  type BarState,
  decode,
  encode,
  isRemoteCommand,
  type SessionInfo,
  type WireMessage,
} from "./protocol";

/** Maps a channel web-backend port to its session, for enriching host info. */
export type ChannelResolver = (port: number) => { tag: string; project: string } | undefined;

/** Ping cadence; a socket that misses one full interval is terminated. */
const HEARTBEAT_MS = 30_000;

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

interface HostConn {
  id: string;
  ws: WebSocket;
  info: SessionInfo;
  registered: boolean;
  /** The most recent bar this host published — replayed to a remote on join. */
  lastBar: BarState | undefined;
  /** Remotes of this host, keyed by client id. */
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

export function createBarBackend(options: BarBackendOptions = {}): BarBackend {
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
  // Never hold the host process open on our account.
  heartbeat.unref?.();

  // ── websocket endpoints (noServer; the host forwards upgrades) ──────────────
  const hostWss = new WebSocketServer({ noServer: true });
  const clientWss = new WebSocketServer({ noServer: true });

  // A browser host: registers, then projects its bar to remotes and receives
  // their commands.
  hostWss.on("connection", (ws) => {
    const id = `host-${++hostSeq}`;
    const conn: HostConn = {
      id,
      ws,
      registered: false,
      lastBar: undefined,
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
        return; // the bar channel carries no binary frames
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
        if (message.channelTag) {
          conn.info.channelTag = message.channelTag;
        }
        if (message.channelPort !== undefined && options.resolveChannel) {
          const resolved = options.resolveChannel(message.channelPort);
          if (resolved) {
            conn.info.channelTag = conn.info.channelTag ?? resolved.tag;
            conn.info.project = conn.info.project ?? resolved.project;
          }
        }
        conn.registered = true;
        log(`bar: host "${conn.info.label}" registered (${hosts.size} host(s))`);
        broadcastSessions();
        return;
      }
      if (message.type === "bar") {
        // Cache for join-time replay, then fan out to current viewers.
        conn.lastBar = message;
        for (const client of conn.clients.values()) {
          send(client.ws, message);
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

  // A remote (bar-only client, or the pencil iPad app) viewing + tapping a host.
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
        send(ws, { type: "joined", host: host.id, label: host.info.label });
        // Replay the host's last bar at once, so an idle host still paints a bar
        // instead of a blank surface (the event-driven divergence from paint).
        if (host.lastBar) {
          send(ws, host.lastBar);
        }
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
      // A bar tap → the host, which dispatches it into the mode engine.
      if (isRemoteCommand(message)) {
        send(conn.host.ws, message);
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
      return false; // an unparseable request-target is never ours
    }
    if ((req.method ?? "GET") !== "GET") {
      return false;
    }
    const pathname = url.pathname;
    // `/info` and `/health` both report readiness + counts; the overlay's
    // capability probe reads `/info` cross-origin, hence the CORS on every JSON
    // route (sendJson sets it).
    if (pathname === `${prefix}/info` || pathname === `${prefix}/health`) {
      sendJson(res, { ok: true, ...counts() });
      return true;
    }
    if (pathname === `${prefix}/sessions`) {
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
