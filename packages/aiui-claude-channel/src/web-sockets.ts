/**
 * The channel's websocket surface: three `noServer` WebSocketServers behind one
 * never-throw upgrade router, plus their connection handlers — `/ws` (the binary
 * stream-processor protocol) and the JSON `/tools` + `/session` hubs.
 *
 * Two invariants live here:
 *  - Nothing in the upgrade listener may throw: an exception in an 'upgrade'
 *    listener is an uncaughtException, which would take down the whole process.
 *    Unclaimed upgrades are offered to `runtime.mountedSidecars` in order, each
 *    sidecar's throw contained.
 *  - The `/ws` handler reads the registry via `runtime.getFormats()` INSIDE the
 *    connection callback (per-connection), so a socket opened after a reload
 *    speaks the freshly loaded layer.
 *
 * `attachChannelSockets` returns `closeAll`, which encapsulates the nested
 * sessionWss → toolsWss → wss close chain so the caller keeps the exact close
 * ordering without the three servers escaping this module.
 */
import type { Server } from "node:http";
import { type RawData, type WebSocket, WebSocketServer } from "ws";
import { createChannelConnection } from "./channel";
import { ackEntry, type FrameLog, inboundEntry, pushEntry } from "./frame-log";
import type { PageToolDirectory } from "./page-tools";
import type { SessionHub } from "./session-hub";
import type { TransportStats } from "./stats";
import type { PromptHandler } from "./web";
import { type ChannelRuntime, errorMessage } from "./web-runtime";

/** Normalize `ws`'s several binary shapes into a single Uint8Array frame. */
const toFrame = (data: RawData): Uint8Array => {
  if (Array.isArray(data)) {
    return Buffer.concat(data);
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  return data;
};

/** The addConnection / handleClientMessage / removeConnection triple both the
 * page-tool directory and the session hub expose (page-tools.ts, session-hub.ts). */
interface JsonHub<M> {
  addConnection(send: (message: M) => void): string;
  handleClientMessage(clientId: string, raw: unknown): void;
  removeConnection(clientId: string): void;
}

/**
 * Attach a JSON-text hub endpoint: each connection registers with the directory,
 * relays parsed text frames to it, and deregisters on close. Binary frames are
 * ignored (these protocols are JSON text only), and a socket `error` is swallowed
 * (it is followed by `close`; an unhandled 'error' on the socket is fatal in Node).
 */
function attachJsonHub<M>(
  wss: WebSocketServer,
  hub: JsonHub<M>,
  liveSockets: Set<WebSocket>,
): void {
  wss.on("connection", (socket) => {
    liveSockets.add(socket);
    const clientId = hub.addConnection((message) => {
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify(message));
      }
    });
    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        return; // JSON text only
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        return; // ignore garbage from a cooperative same-host client
      }
      hub.handleClientMessage(clientId, parsed);
    });
    socket.on("close", () => {
      liveSockets.delete(socket);
      hub.removeConnection(clientId);
    });
    socket.on("error", () => {});
  });
}

export interface ChannelSocketDeps {
  /** The shared-state cluster: formats getter, live-socket set, mounted sidecars. */
  runtime: ChannelRuntime;
  /** The prompt sink each `/ws` stream processor pushes into. */
  onPrompt: PromptHandler;
  /** The protocol frame log (inbound/ack/push entries). */
  frameLog: FrameLog;
  /** The server-side transport counters. */
  stats: TransportStats;
  /** The page-tool directory the `/tools` hub feeds. */
  pageTools: PageToolDirectory;
  /** The session bus the `/session` hub feeds. */
  sessionHub: SessionHub;
  /** Server-level debug mode, forwarded to each channel connection. */
  debug?: boolean;
  /** Log sink for server-level messages (a sidecar upgrade handler throwing). */
  log: (message: string) => void;
}

/**
 * Attach the channel's websocket endpoints to the HTTP server. Returns a
 * `closeAll` that tears the three servers down in the pinned order.
 */
export function attachChannelSockets(
  httpServer: Server,
  deps: ChannelSocketDeps,
): { closeAll(cb: () => void): void } {
  const { runtime, onPrompt, frameLog, stats, pageTools, sessionHub, log } = deps;

  const wss = new WebSocketServer({ noServer: true });
  const toolsWss = new WebSocketServer({ noServer: true });
  const sessionWss = new WebSocketServer({ noServer: true });
  httpServer.on("upgrade", (req, socket, head) => {
    // Nothing in here may throw: an exception in an 'upgrade' listener is an
    // uncaughtException, which would take down the whole channel process.
    let pathname: string;
    try {
      pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    } catch {
      socket.destroy(); // malformed request-target
      return;
    }
    if (pathname === "/ws") {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    } else if (pathname === "/tools") {
      toolsWss.handleUpgrade(req, socket, head, (ws) => toolsWss.emit("connection", ws, req));
    } else if (pathname === "/session") {
      sessionWss.handleUpgrade(req, socket, head, (ws) => sessionWss.emit("connection", ws, req));
    } else {
      // Offer the upgrade to each sidecar (e.g. the pencil sidecar's stroke
      // sockets); the first to claim it owns the socket. Nothing claims it →
      // drop, as before. A sidecar
      // that throws mid-handshake is contained (logged, socket dropped) — one bad
      // sidecar must not sink the session.
      for (const sidecar of runtime.mountedSidecars) {
        try {
          if (sidecar.handleUpgrade?.(req, socket, head)) {
            return;
          }
        } catch (err) {
          log(`a sidecar upgrade handler threw: ${errorMessage(err)}`);
          socket.destroy();
          return;
        }
      }
      socket.destroy();
    }
  });

  wss.on("connection", (socket) => {
    stats.connectionOpened();
    runtime.liveSockets.add(socket);
    // A processor may push server → client messages (the `intent-v1` lowering
    // sends `lowered` events) out-of-band of the per-frame acks; the client
    // tells them apart by their `kind` field. Reads the registry via
    // `runtime.getFormats()` at connect time, so a connection opened after a
    // reload speaks the freshly loaded layer.
    const connection = createChannelConnection({
      formats: runtime.getFormats(),
      sendPrompt: onPrompt,
      push: (message) => {
        // Logged even if the socket already dropped: the push *happened* (the
        // frame log is the server's record, not the client's).
        frameLog.record(pushEntry(message));
        if (socket.readyState === socket.OPEN) {
          socket.send(JSON.stringify(message));
        }
      },
      ...(deps.debug === true ? { debug: true } : {}),
    });
    socket.on("close", () => {
      runtime.liveSockets.delete(socket);
      stats.connectionClosed();
      // Tear down any thread abandoned mid-turn (socket dropped before its
      // `fin`) so processors release per-thread resources instead of leaking.
      // A reload drops the socket the same way, so onClose teardown runs then too.
      void connection.close();
    });
    socket.on("message", async (data, isBinary) => {
      if (!isBinary) {
        const rejection = { ok: false, fatal: true, error: "expected a binary frame" };
        frameLog.record(ackEntry(rejection));
        socket.send(JSON.stringify(rejection));
        socket.close();
        return;
      }
      // Acks stay small JSON text frames; the high-bandwidth direction (data
      // in) is what the binary framing optimizes.
      const frame = toFrame(data);
      // Log the inbound frame before handling it, so a push produced *while*
      // handling (a lowered-prompt, a transcript echo) sits after its cause.
      frameLog.record(inboundEntry(frame));
      const handledAt = performance.now();
      const response = await connection.handleFrame(frame);
      stats.recordFrame({
        bytes: frame.length,
        processMs: performance.now() - handledAt,
        ok: response.ok,
        ...(response.threadId ? { threadId: response.threadId } : {}),
        ...(response.closed ? { closed: true } : {}),
      });
      frameLog.record(ackEntry(response));
      socket.send(JSON.stringify(response));
      if (response.fatal) {
        socket.close();
      }
    });
  });

  // The `/tools` and `/session` endpoints are the same JSON-text hub protocol
  // over two directories exposing the identical addConnection /
  // handleClientMessage / removeConnection triple: `/tools` feeds the page-tool
  // directory (a page declaring its tool set and answering routed calls),
  // `/session` the multi-view session bus (shared arming + prompt preview +
  // contributions across a session's tabs). Reload closes these sockets, which
  // drops their registrations; the bridge reconnects and re-registers.
  attachJsonHub(toolsWss, pageTools, runtime.liveSockets);
  attachJsonHub(sessionWss, sessionHub, runtime.liveSockets);

  return {
    closeAll(cb: () => void) {
      sessionWss.close(() => toolsWss.close(() => wss.close(() => cb())));
    },
  };
}
