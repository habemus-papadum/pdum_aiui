/**
 * The channel server's web backend.
 *
 * A small HTTP + WebSocket server the outside world uses to push data into the
 * Claude Code session behind this MCP server. It exposes a health check, a
 * `POST /prompt` that forwards its `text` to the session, and a `/ws`
 * websocket speaking the binary stream-processor protocol (see channel.ts and
 * frame.ts): the client's initial hello picks a format out of the registry,
 * and each thread of binary frames is decoded with that format's codec and fed
 * to its own processor, which pushes prompts into the session as it sees fit.
 * Binary frames keep audio/screenshot/video payloads raw (never base64'd). It
 * listens on an OS-assigned port, on loopback only.
 *
 * Nothing here may write to stdout: in the `mcp` command that stream carries the
 * MCP stdio protocol. Surface problems through the returned promise instead.
 */
import { createServer } from "node:http";
import express from "express";
import { type RawData, WebSocketServer } from "ws";
import { createChannelConnection, type FormatRegistry } from "./channel";
import { registerDebugRoutes } from "./debug";
import type { LaunchInfo } from "./launch-info";
import { PageToolDirectory } from "./page-tools";
import { defaultFormats } from "./processors";
import { createTransportStats } from "./stats";
import { createTraceStore } from "./trace";
import { withTracing } from "./tracing";

/** Forward prompt text into the Claude Code session. */
export type PromptHandler = (text: string) => void | Promise<void>;

export interface WebServerOptions {
  /** Called with text arriving over `POST /prompt` or from a stream processor. */
  onPrompt: PromptHandler;
  /**
   * Stream formats the websocket protocol accepts, keyed by the name clients
   * declare in their hello. Defaults to {@link defaultFormats}.
   */
  formats?: FormatRegistry;
  /**
   * Project-local cache directory (see {@link projectCacheDir}). When set,
   * every websocket thread records a lowering trace there and the `/debug`
   * viewer + API are served. Omit to disable tracing (e.g. in tests).
   */
  traceDir?: string;
  /**
   * Launcher-provided session summary (how the Chrome DevTools MCP was wired,
   * etc. — see launch-info.ts), surfaced at `GET /debug/api/info`.
   */
  launchInfo?: LaunchInfo;
  /**
   * The registry of in-browser tools the `/tools` websocket feeds and the MCP
   * layer reads (see {@link PageToolDirectory}). Pass the same instance the MCP
   * server was built with so tool calls reach live pages; omitted, a fresh one
   * is created (and returned on the handle).
   */
  pageTools?: PageToolDirectory;
}

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

export interface WebServer {
  /** The port the backend bound to (chosen by the OS). */
  port: number;
  /**
   * The page-tool registry the `/tools` websocket feeds. The MCP layer reads
   * and drives it; surfaced here so a caller that let the server create one can
   * still reach it.
   */
  pageTools: PageToolDirectory;
  /** Stop accepting connections and release the port. */
  close: () => Promise<void>;
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Start the web backend on `127.0.0.1:<random free port>`, resolving once it's
 * listening.
 */
export async function startWebServer(options: WebServerOptions): Promise<WebServer> {
  const app = express();
  app.use(express.json());

  const pageTools = options.pageTools ?? new PageToolDirectory();

  app.get("/health", (_req, res) => {
    // Readable cross-origin: the dev overlay's tools bridge probes this route
    // from the app's dev-server origin before dialing `/tools` (the browser
    // logs failed websocket handshakes unsuppressably, so it never dials
    // blind). The payload is harmless loopback metadata, and the header's
    // presence is part of the capability signal — it ships together with the
    // `/tools` endpoint, so a CORS-refused probe means an older channel.
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.json({ ok: true, pid: process.pid, ppid: process.ppid, pageTools: pageTools.summary() });
  });

  app.post("/prompt", async (req, res) => {
    const text = typeof req.body?.text === "string" ? req.body.text : "";
    if (!text) {
      res.status(400).json({ ok: false, error: "expected a non-empty 'text' field" });
      return;
    }
    try {
      await options.onPrompt(text);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: errorMessage(err) });
    }
  });

  const httpServer = createServer(app);

  // Each websocket connection gets its own protocol state machine; its threads
  // die with the connection, and concurrent clients never share state. With a
  // traceDir, every thread also records a lowering trace and /debug serves the
  // viewer over them, plus the server-side transport counters.
  const stats = createTransportStats();
  let formats = options.formats ?? defaultFormats();
  if (options.traceDir) {
    formats = withTracing(formats, createTraceStore(options.traceDir));
    registerDebugRoutes(app, options.traceDir, stats, options.launchInfo);
  }
  // Two websocket endpoints share one HTTP server: `/ws` (the binary
  // stream-processor protocol) and `/tools` (the JSON page-tool protocol). When
  // several `WebSocketServer`s attach via the `server` option they fight over
  // the upgrade, so both run in `noServer` mode and one upgrade listener routes
  // by path (anything else is dropped).
  const wss = new WebSocketServer({ noServer: true });
  const toolsWss = new WebSocketServer({ noServer: true });
  httpServer.on("upgrade", (req, socket, head) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (pathname === "/ws") {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    } else if (pathname === "/tools") {
      toolsWss.handleUpgrade(req, socket, head, (ws) => toolsWss.emit("connection", ws, req));
    } else {
      socket.destroy();
    }
  });

  wss.on("connection", (socket) => {
    stats.connectionOpened();
    socket.on("close", () => stats.connectionClosed());
    const connection = createChannelConnection({ formats, sendPrompt: options.onPrompt });
    socket.on("message", async (data, isBinary) => {
      if (!isBinary) {
        socket.send(JSON.stringify({ ok: false, fatal: true, error: "expected a binary frame" }));
        socket.close();
        return;
      }
      // Acks stay small JSON text frames; the high-bandwidth direction (data
      // in) is what the binary framing optimizes.
      const frame = toFrame(data);
      const handledAt = performance.now();
      const response = await connection.handleFrame(frame);
      stats.recordFrame({
        bytes: frame.length,
        processMs: performance.now() - handledAt,
        ok: response.ok,
        ...(response.threadId ? { threadId: response.threadId } : {}),
        ...(response.closed ? { closed: true } : {}),
      });
      socket.send(JSON.stringify(response));
      if (response.fatal) {
        socket.close();
      }
    });
  });

  // The `/tools` endpoint: a page declares its tool set as JSON text frames and
  // answers the calls the directory routes to it. Unlike `/ws` this is a plain
  // JSON protocol — the payloads are tiny schemas and results, not media.
  toolsWss.on("connection", (socket) => {
    const clientId = pageTools.addConnection((message) => {
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify(message));
      }
    });
    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        return; // the tools protocol is JSON text only
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        return; // ignore garbage from a cooperative same-host client
      }
      pageTools.handleClientMessage(clientId, parsed);
    });
    socket.on("close", () => pageTools.removeConnection(clientId));
    // A socket error is followed by `close`; swallow it so it doesn't crash the
    // process (Node treats an unhandled 'error' on the socket as fatal).
    socket.on("error", () => {});
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    httpServer.once("error", rejectListen);
    httpServer.listen(0, "127.0.0.1", () => {
      httpServer.removeListener("error", rejectListen);
      resolveListen();
    });
  });

  const address = httpServer.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;

  const close = (): Promise<void> =>
    new Promise((resolveClose) => {
      toolsWss.close(() => wss.close(() => httpServer.close(() => resolveClose())));
    });

  return { port, pageTools, close };
}
