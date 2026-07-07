/**
 * backend.ts — the paint-stream coordinator as a **host-neutral backend**.
 *
 * This is the relay's room logic (pair a desktop **host** with iPad **clients**,
 * relay intents/view-state/video/signaling between them) packaged the way
 * aiui-code-server packages the reader backend: two seams — an HTTP handler and
 * a websocket-upgrade handler — that a host process mounts wherever it likes.
 * It never listens on a port itself. Three hosts exist today:
 *
 *  - the **channel sidecar** (`./sidecar`): mounts it at `/paint` on the aiui
 *    channel's loopback server (where the app page already knows the port) AND
 *    on a separate LAN listener for the iPad — the channel's loopback-only
 *    posture is untouched;
 *  - the **standalone demo** (`demo/serve.ts`): a bespoke Express server;
 *  - anything else that can forward a request and an upgrade.
 *
 * Routes (all under {@link PaintBackendOptions.prefix}, default ``):
 *   GET  <prefix>/          the self-contained iPad client page
 *   GET  <prefix>/sessions  the connectable hosts, as JSON
 *   WS   <prefix>/host      a desktop browser host
 *   WS   <prefix>/client    an iPad (or any browser) viewer
 *
 * Relay semantics (unchanged from the original design): host → clients gets
 * JSON view-state + opaque binary JPEG frames; clients → host gets paint /
 * navigation intents; WebRTC signaling is addressed per-peer (see protocol.ts).
 * Two robustness rules this backend adds over the original relay:
 *   - **heartbeat**: dead sockets (an iPad that slept) are ping-terminated, so
 *     a zombie viewer can't hold a room "busy" for the TCP timeout;
 *   - **backpressure**: a binary frame is dropped for a viewer whose socket
 *     buffer is backed up — video is latest-wins, control is never dropped.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { type RawData, type WebSocket, WebSocketServer } from "ws";
import { IPAD_CLIENT_HTML } from "./ipad-client";
import { decode, encode, isPaintIntent, type SessionInfo, type WireMessage } from "./protocol";

/** Maps a channel web-backend port to its session, for enriching host info. */
export type ChannelResolver = (port: number) => { tag: string; project: string } | undefined;

/** Ping cadence; a socket that misses one full interval is terminated. */
const HEARTBEAT_MS = 30_000;

/** A viewer this far behind (bytes buffered) skips video frames until it drains. */
const MAX_BUFFERED_BYTES = 1_500_000;

export interface PaintBackendOptions {
  /** Path prefix all routes live under (e.g. `"/paint"`). Default: none. */
  prefix?: string;
  /**
   * Static session identity every host registered here inherits when it doesn't
   * announce its own — the channel sidecar passes its project root, so the iPad
   * list shows which session a browser belongs to.
   */
  session?: { project?: string; channelTag?: string };
  /**
   * Resolve a host-announced channel port to `{ tag, project }` (multi-session
   * deployments). No default — the single-session sidecar uses {@link session},
   * and the demo needs neither.
   */
  resolveChannel?: ChannelResolver;
  /** Line logger for lifecycle diagnostics (defaults to silent). */
  log?: (line: string) => void;
}

export interface PaintBackend {
  /** Handle an HTTP request for a paint route. Returns true if handled. */
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
  /** Viewers of this host, keyed by client id so signaling can address one. */
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

/** Forward a raw binary (video) frame — latest-wins: skipped when the viewer's
 * socket is backed up, so a slow iPad lags instead of ballooning memory. */
function sendVideoFrame(ws: WebSocket, data: RawData): void {
  if (ws.readyState === ws.OPEN && ws.bufferedAmount <= MAX_BUFFERED_BYTES) {
    ws.send(data, { binary: true });
  }
}

export function createPaintBackend(options: PaintBackendOptions = {}): PaintBackend {
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
  // An iPad that sleeps or drops off Wi-Fi never sends a FIN; without this its
  // zombie connection holds the room (and the host's `busy` flag) until the TCP
  // stack gives up. `ws` answers pings automatically on live peers.
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

  // A browser host: registers, then streams frames + view-state to its viewers
  // and receives their intents.
  hostWss.on("connection", (ws) => {
    const id = `host-${++hostSeq}`;
    const conn: HostConn = {
      id,
      ws,
      registered: false,
      clients: new Map(),
      info: {
        id,
        label: "browser",
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
        // A JPEG video frame (frame-streaming mode): fan out, latest-wins.
        for (const client of conn.clients.values()) {
          sendVideoFrame(client.ws, data);
        }
        return;
      }
      const message = decode(data.toString());
      if (!message) {
        return;
      }
      if (message.type === "register") {
        conn.info.label = message.label || "browser";
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
        log(`paint: host "${conn.info.label}" registered (${hosts.size} host(s))`);
        broadcastSessions();
        return;
      }
      // viewState + videoStatus → every viewer; signal → the one addressed viewer
      // (WebRTC is point-to-point, so signaling can't broadcast — see Signal.peer).
      if (message.type === "viewState" || message.type === "videoStatus") {
        for (const client of conn.clients.values()) {
          send(client.ws, message);
        }
      } else if (message.type === "signal") {
        const target =
          typeof message.peer === "string" ? conn.clients.get(message.peer) : undefined;
        if (target) {
          send(target.ws, { type: "signal", data: message.data });
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

  // An iPad (or any browser) viewing + drawing on a host.
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
        return; // clients don't push media in this build
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
      // Signaling → the host, stamped with this client's id so the host knows
      // which peer connection it belongs to. Paint/navigation intents → the host.
      if (message.type === "signal") {
        send(conn.host.ws, { type: "signal", peer: conn.id, data: message.data });
      } else if (isPaintIntent(message)) {
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
    const pathname = url.pathname;
    if ((req.method ?? "GET") !== "GET") {
      return false;
    }
    if (pathname === `${prefix}/` || (prefix !== "" && pathname === prefix)) {
      // The iPad client page. Its inline JS derives the /client websocket path
      // from location.pathname, so it works under any prefix.
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(IPAD_CLIENT_HTML);
      return true;
    }
    if (pathname === `${prefix}/sessions`) {
      sendJson(res, { sessions: sessions() });
      return true;
    }
    if (pathname === `${prefix}/health`) {
      sendJson(res, { ok: true, hosts: hosts.size, clients: clients.size });
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

  return {
    handleHttp,
    handleUpgrade,
    sessions,
    counts: () => ({ hosts: hosts.size, clients: clients.size }),
    dispose,
  };
}
