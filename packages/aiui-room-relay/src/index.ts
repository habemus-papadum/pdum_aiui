/**
 * @habemus-papadum/aiui-room-relay — the host-neutral room relay.
 *
 * The room logic that pairs a browser **host** with remote **clients** —
 * register / join / leave / sessions / heartbeat, plus a per-host slot the relay
 * replays on join — as the two seams a host process mounts: an HTTP handler and a
 * websocket-upgrade handler. It never listens on a port itself.
 *
 * The core owns everything that is message-agnostic; each consumer supplies a
 * **vocabulary delegate** ({@link RoomRelayDelegate}) for its own wire: how to
 * frame a message ({@link RoomRelayDelegate.encode}/{@link RoomRelayDelegate.decode}),
 * what a `register` contributes to a session ({@link RoomRelayDelegate.registerExtras}),
 * and how host/client messages route ({@link RoomRelayDelegate.onHostMessage}/
 * {@link RoomRelayDelegate.onClientMessage}). The server frames the relay emits
 * (`registered`, `sessions`, `joined`, `clientJoined`, `clientLeft`, `hostGone`,
 * `joinRejected`) are the {@link RoomServerFrame} shapes every consumer's wire
 * union includes — each ties its union to them with {@link Assignable}.
 *
 * **Node-only** (`ws` + `node:http`/`node:stream` types); never import it on a
 * browser-reachable path.
 *
 * Routes (all under {@link RoomRelayOptions.prefix}, default ``):
 *   GET  <prefix>/info      readiness + counts, JSON (CORS — probes read it)
 *   GET  <prefix>/health    liveness + counts, JSON
 *   GET  <prefix>/sessions  the connectable hosts, JSON
 *   WS   <prefix>/host      a browser host
 *   WS   <prefix>/client    a remote client
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { type WebSocket, WebSocketServer } from "ws";

/** Maps a channel web-backend port to its session, for enriching host info. */
export type ChannelResolver = (port: number) => { tag: string; project: string } | undefined;

/**
 * Type-level assertion, used as a generic argument: `Assignable<Super, Sub>`
 * evaluates to `Super`, but fails to type-check unless `Sub` is assignable to
 * `Super`. A consumer instantiates the relay as
 * `createRoomRelayBackend<Assignable<WireMessage, RoomServerFrame>>(…)`, which
 * still sets `M = WireMessage` while proving — at the call site, with no unused
 * binding — that the core's cast of a built server frame to `M` is sound.
 */
export type Assignable<Super, Sub extends Super> = Sub extends Super ? Super : never;

/** The session identity the relay advertises for each connectable host. Consumers
 * layer their own extra fields on via {@link RoomRelayDelegate.registerExtras}. */
export interface RoomSessionInfo {
  id: string;
  label: string;
  project?: string;
  channelTag?: string;
  busy: boolean;
  connectedAt: string;
}

/** The frames the relay itself emits — part of every consumer's wire union. */
export type RoomServerFrame =
  | { type: "registered"; id: string }
  | { type: "sessions"; sessions: RoomSessionInfo[] }
  | { type: "joinRejected"; reason: string }
  | { type: "joined"; host: string; label: string }
  | { type: "clientJoined"; client: string }
  | { type: "clientLeft"; client: string }
  | { type: "hostGone" };

/** Handed to {@link RoomRelayDelegate.onHostMessage} for a host's own frames. */
export interface HostMessageContext<M> {
  /** Set this host's replay slot and fan the frame out to its current clients. */
  cacheForReplay(message: M): void;
  /** Route a frame to one client of this host; false if `clientId` is absent or gone. */
  sendToClient(clientId: string | undefined, message: M): boolean;
}

/** Handed to {@link RoomRelayDelegate.onClientMessage} for a joined client's frames. */
export interface ClientMessageContext<M> {
  /** This client's relay-assigned id. */
  clientId: string;
  /** Forward a frame to the host this client has joined. */
  sendToHost(message: M): void;
}

/** The per-wire vocabulary the room core delegates to. */
export interface RoomRelayDelegate<M extends { type: string }> {
  /** Prefixes the registration log line (`"<logPrefix>: host …"`). */
  logPrefix: string;
  /** Parse a text frame, or `undefined` for a malformed one. */
  decode(text: string): M | undefined;
  /** Serialize a frame to text. */
  encode(message: M): string;
  /** Fields a `register` frame contributes to the session (e.g. presentation, channelTag). */
  registerExtras?(message: M): Record<string, unknown>;
  /** Fields the `joined` frame carries beyond `{ host, label }` (e.g. presentation). */
  joinedExtras?(info: RoomSessionInfo): Record<string, unknown>;
  /** Route a host's non-`register` frame (cache-and-fan-out, or client-directed). */
  onHostMessage(message: M, ctx: HostMessageContext<M>): void;
  /** Route a joined client's non-`join`/`leave` frame (forward up to the host). */
  onClientMessage(message: M, ctx: ClientMessageContext<M>): void;
}

/** Options for {@link createRoomRelayBackend}: the room knobs plus the delegate. */
export interface RoomRelayOptions<M extends { type: string }> extends RoomRelayDelegate<M> {
  /** Path prefix all routes live under (e.g. `"/pencil"`). Default: none. */
  prefix?: string;
  /** Static session identity hosts inherit when they don't announce their own. */
  session?: { project?: string; channelTag?: string };
  /** Resolve a host-announced channel port to `{ tag, project }`. */
  resolveChannel?: ChannelResolver;
  /** Line logger for lifecycle diagnostics (defaults to silent). */
  log?: (line: string) => void;
}

export interface RoomRelayBackend {
  /** Handle an HTTP request for a relay route. Returns true if handled. */
  handleHttp(req: IncomingMessage, res: ServerResponse): boolean;
  /** Handle a websocket upgrade for `<prefix>/host` or `<prefix>/client`. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean;
  /** The currently connectable hosts. */
  sessions(): RoomSessionInfo[];
  /** Live connection counts (for info routes + tests). */
  counts(): { hosts: number; clients: number };
  /** Close every connection and stop the heartbeat. */
  dispose(): void;
}

/** Ping cadence; a socket that misses one full interval is terminated. */
const HEARTBEAT_MS = 30_000;

interface HostConn<M> {
  id: string;
  ws: WebSocket;
  info: RoomSessionInfo;
  registered: boolean;
  /** The last cached frame — replayed on join, so a joiner never starts blank. */
  replaySlot: M | undefined;
  /** Clients of this host, keyed by client id. */
  clients: Map<string, ClientConn<M>>;
}

interface ClientConn<M> {
  id: string;
  ws: WebSocket;
  host: HostConn<M> | undefined;
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

/** The `register` fields the core reads generically; the rest is the delegate's. */
interface RegisterFields {
  label?: string;
  project?: string;
  channelPort?: number;
}

export function createRoomRelayBackend<M extends { type: string }>(
  options: RoomRelayOptions<M>,
): RoomRelayBackend {
  const {
    logPrefix,
    decode,
    encode,
    registerExtras,
    joinedExtras,
    onHostMessage,
    onClientMessage,
  } = options;
  const prefix = options.prefix ?? "";
  const log = options.log ?? (() => {});
  const hosts = new Map<string, HostConn<M>>();
  const clients = new Set<ClientConn<M>>();
  let hostSeq = 0;
  let clientSeq = 0;

  /** Send a wire frame if the socket is open. */
  const send = (ws: WebSocket, message: M): void => {
    if (ws.readyState === ws.OPEN) {
      ws.send(encode(message));
    }
  };

  /** Cast a relay-built server frame to the wire type `M` (sound because every
   * consumer asserts `RoomServerFrame extends WireMessage`); `extra` carries a
   * delegate's per-frame additions. The core's single loose seam over `M`. */
  const asWire = (frame: RoomServerFrame, extra?: Record<string, unknown>): M =>
    (extra ? { ...frame, ...extra } : frame) as unknown as M;

  const sessions = (): RoomSessionInfo[] =>
    [...hosts.values()].filter((h) => h.registered).map((h) => ({ ...h.info }));

  const broadcastSessions = (): void => {
    const list = sessions();
    for (const client of clients) {
      send(client.ws, asWire({ type: "sessions", sessions: list }));
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

  // ── websocket endpoints (noServer; the host process forwards upgrades) ──────
  const hostWss = new WebSocketServer({ noServer: true });
  const clientWss = new WebSocketServer({ noServer: true });

  hostWss.on("connection", (ws) => {
    const id = `host-${++hostSeq}`;
    const conn: HostConn<M> = {
      id,
      ws,
      registered: false,
      replaySlot: undefined,
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
    send(ws, asWire({ type: "registered", id }));

    const hostCtx: HostMessageContext<M> = {
      cacheForReplay(message) {
        conn.replaySlot = message;
        for (const client of conn.clients.values()) {
          send(client.ws, message);
        }
      },
      sendToClient(clientId, message) {
        if (clientId === undefined) {
          return false;
        }
        const target = conn.clients.get(clientId);
        if (!target) {
          return false;
        }
        send(target.ws, message);
        return true;
      },
    };

    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        return; // control frames only — no binary on the relay wire
      }
      const message = decode(data.toString());
      if (!message) {
        return;
      }
      if (message.type === "register") {
        const reg = message as unknown as RegisterFields;
        conn.info.label = reg.label || "app";
        if (reg.project) {
          conn.info.project = reg.project;
        }
        const extras = registerExtras?.(message);
        if (extras) {
          Object.assign(conn.info, extras);
        }
        if (reg.channelPort !== undefined && options.resolveChannel) {
          const resolved = options.resolveChannel(reg.channelPort);
          if (resolved) {
            conn.info.channelTag = conn.info.channelTag ?? resolved.tag;
            conn.info.project = conn.info.project ?? resolved.project;
          }
        }
        conn.registered = true;
        log(`${logPrefix}: host "${conn.info.label}" registered (${hosts.size} host(s))`);
        broadcastSessions();
        return;
      }
      onHostMessage(message, hostCtx);
    });

    ws.on("close", () => {
      hosts.delete(id);
      for (const client of conn.clients.values()) {
        client.host = undefined;
        send(client.ws, asWire({ type: "hostGone" }));
      }
      conn.clients.clear();
      broadcastSessions();
    });
    ws.on("error", () => {});
  });

  clientWss.on("connection", (ws) => {
    const conn: ClientConn<M> = { id: `client-${++clientSeq}`, ws, host: undefined };
    clients.add(conn);
    track(ws);
    send(ws, asWire({ type: "sessions", sessions: sessions() }));

    const leaveRoom = (): void => {
      const host = conn.host;
      if (!host) {
        return;
      }
      host.clients.delete(conn.id);
      conn.host = undefined;
      host.info.busy = host.clients.size > 0;
      send(host.ws, asWire({ type: "clientLeft", client: conn.id }));
      broadcastSessions();
    };

    const clientCtx: ClientMessageContext<M> = {
      clientId: conn.id,
      sendToHost(message) {
        if (conn.host) {
          send(conn.host.ws, message);
        }
      },
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
        const host = hosts.get((message as unknown as { host: string }).host);
        if (!host?.registered) {
          send(ws, asWire({ type: "joinRejected", reason: "host not found" }));
          return;
        }
        conn.host = host;
        host.clients.set(conn.id, conn);
        host.info.busy = true;
        send(
          ws,
          asWire(
            { type: "joined", host: host.id, label: host.info.label },
            joinedExtras?.(host.info),
          ),
        );
        // Join replay: a quiet host would otherwise leave a new client with
        // nothing until its next publish — never, if the app stays idle.
        if (host.replaySlot) {
          send(ws, host.replaySlot);
        }
        send(host.ws, asWire({ type: "clientJoined", client: conn.id }));
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
      onClientMessage(message, clientCtx);
    });

    ws.on("close", () => {
      leaveRoom();
      clients.delete(conn);
    });
    ws.on("error", () => {});
  });

  // ── the host-neutral seams ───────────────────────────────────────────────────
  const counts = (): { hosts: number; clients: number } => ({
    hosts: hosts.size,
    clients: clients.size,
  });

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
