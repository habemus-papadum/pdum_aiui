/**
 * The paint-stream relay: a small HTTP + WebSocket coordinator that lets an
 * iPad (or any browser) view and draw on a desktop browser over the LAN.
 *
 * It plays the "shared backend" role from the design doc: it never owns the
 * painting model and barely touches the media — it pairs a **host** (the desktop
 * browser, `/host`) with one or more **clients** (the iPad, `/client`) into a room
 * and relays between them:
 *   - host → clients: JSON view-state + opaque binary JPEG frames (broadcast);
 *   - clients → host: JSON paint/navigation intents;
 *   - either direction: WebRTC signaling, addressed to one peer (see below).
 * Signaling is the one thing it can't broadcast: WebRTC is point-to-point, so a
 * `signal` from the host carries a `peer` (client id) the relay routes to, and a
 * `signal` from a client is stamped with its id before reaching the host. It also
 * advertises the list of connectable hosts, enriched from the on-disk aiui channel
 * registry (both live on the same machine) so each browser shows which agent
 * session it belongs to.
 *
 * SECURITY: unlike the channel server, this binds the LAN (`0.0.0.0`) and is
 * UNAUTHENTICATED by design — it is meant for a personal, trusted network (see
 * the package README's warning). Keep it off untrusted networks. It is a
 * SEPARATE process from the loopback-only channel server, whose posture it does
 * not change.
 */
import { createServer, type Server } from "node:http";
import { listMcpServers } from "@habemus-papadum/aiui-claude-channel";
import express from "express";
import { type RawData, type WebSocket, WebSocketServer } from "ws";
import { IPAD_CLIENT_HTML } from "./ipad-client";
import { decode, encode, isPaintIntent, type SessionInfo, type WireMessage } from "./protocol";

/** The default LAN port. Chosen to avoid the usual dev-server range. */
export const DEFAULT_RELAY_PORT = 8788;

/** Maps a channel web-backend port to its session, for enriching host info. */
export type ChannelResolver = (port: number) => { tag: string; project: string } | undefined;

export interface PaintRelayOptions {
  /** Bind address. Defaults to `0.0.0.0` (LAN — that is the point of the relay). */
  host?: string;
  /** Port. Defaults to {@link DEFAULT_RELAY_PORT}; pass `0` for an OS-assigned one. */
  port?: number;
  /** Serve the built-in iPad client at `GET /`. Defaults to `true`. */
  serveClient?: boolean;
  /**
   * Resolve a channel port to its `{ tag, project }`. Defaults to reading the
   * aiui server registry (`listMcpServers`). Injected by tests.
   */
  resolveChannel?: ChannelResolver;
}

export interface PaintRelay {
  host: string;
  port: number;
  /** A URL a browser on the LAN can open (uses the bound port; host is the wildcard bind). */
  url: (lanAddress?: string) => string;
  /** The currently connectable hosts. */
  sessions: () => SessionInfo[];
  /** Number of live host / client connections (for tests + `/health`). */
  counts: () => { hosts: number; clients: number };
  close: () => Promise<void>;
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

const defaultResolver: ChannelResolver = (port) => {
  try {
    for (const server of listMcpServers()) {
      if (server.port === port) {
        return { tag: server.tag, project: server.cwd };
      }
    }
  } catch {
    // A registry read failure just means no enrichment; the host still lists.
  }
  return undefined;
};

/** Send a JSON control frame if the socket is open. */
function send(ws: WebSocket, message: WireMessage): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(encode(message));
  }
}

/** Forward a raw binary frame (a video frame) if the socket is open. */
function sendRaw(ws: WebSocket, data: RawData, isBinary: boolean): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(data, { binary: isBinary });
  }
}

/**
 * Start the relay, resolving once it is listening.
 */
export async function startPaintRelay(options: PaintRelayOptions = {}): Promise<PaintRelay> {
  const bindHost = options.host ?? "0.0.0.0";
  const resolveChannel = options.resolveChannel ?? defaultResolver;

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

  // ── HTTP ───────────────────────────────────────────────────────────────────
  const app = express();
  app.use(express.json());
  app.get("/health", (_req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.json({ ok: true, hosts: hosts.size, clients: clients.size });
  });
  app.get("/sessions", (_req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.json({ sessions: sessions() });
  });
  if (options.serveClient ?? true) {
    app.get("/", (_req, res) => {
      res.type("html").send(IPAD_CLIENT_HTML);
    });
  }

  const httpServer: Server = createServer(app);

  // ── WebSocket: /host and /client share one HTTP server (noServer routing) ────
  const hostWss = new WebSocketServer({ noServer: true });
  const clientWss = new WebSocketServer({ noServer: true });
  httpServer.on("upgrade", (req, socket, head) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (pathname === "/host") {
      hostWss.handleUpgrade(req, socket, head, (ws) => hostWss.emit("connection", ws, req));
    } else if (pathname === "/client") {
      clientWss.handleUpgrade(req, socket, head, (ws) => clientWss.emit("connection", ws, req));
    } else {
      socket.destroy();
    }
  });

  // A browser host: registers, then streams frames + view-state to its viewers
  // and receives their intents.
  hostWss.on("connection", (ws) => {
    const id = `host-${++hostSeq}`;
    const conn: HostConn = {
      id,
      ws,
      registered: false,
      clients: new Map(),
      info: { id, label: "browser", busy: false, connectedAt: new Date().toISOString() },
    };
    hosts.set(id, conn);
    send(ws, { type: "registered", id });

    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        // A JPEG video frame (frame-streaming mode): fan out to every viewer.
        for (const client of conn.clients.values()) {
          sendRaw(client.ws, data, true);
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
        if (message.channelPort !== undefined) {
          const resolved = resolveChannel(message.channelPort);
          if (resolved) {
            conn.info.channelTag = conn.info.channelTag ?? resolved.tag;
            conn.info.project = conn.info.project ?? resolved.project;
          }
        }
        conn.registered = true;
        broadcastSessions();
        return;
      }
      // viewState → every viewer; signal → the one addressed viewer (WebRTC is
      // point-to-point, so signaling can't broadcast — see Signal.peer).
      if (message.type === "viewState") {
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

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(options.port ?? DEFAULT_RELAY_PORT, bindHost, () => {
      httpServer.removeListener("error", reject);
      resolve();
    });
  });

  const address = httpServer.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;

  return {
    host: bindHost,
    port,
    url: (lanAddress) => `http://${lanAddress ?? "localhost"}:${port}/`,
    sessions,
    counts: () => ({ hosts: hosts.size, clients: clients.size }),
    close: () =>
      new Promise<void>((resolve) => {
        for (const conn of hosts.values()) {
          conn.ws.close();
        }
        for (const conn of clients) {
          conn.ws.close();
        }
        clientWss.close(() => hostWss.close(() => httpServer.close(() => resolve())));
      }),
  };
}
