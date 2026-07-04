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

  app.get("/health", (_req, res) => {
    res.json({ ok: true, pid: process.pid, ppid: process.ppid });
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
  const wss = new WebSocketServer({ server: httpServer, path: "/ws" });
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
      wss.close(() => httpServer.close(() => resolveClose()));
    });

  return { port, close };
}
