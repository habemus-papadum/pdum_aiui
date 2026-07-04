/**
 * The channel server's web backend.
 *
 * A small HTTP + WebSocket server the outside world uses to push text into the
 * Claude Code session behind this MCP server. It exposes a health check, a
 * `POST /prompt` that forwards its `text` to the session, and a `/ws`
 * websocket speaking the stream-processor protocol (see channel.ts): the
 * client's initial hello picks a format out of the processor registry, and
 * each thread of messages is fed to its own processor, which pushes prompts
 * into the session as it sees fit. It listens on an OS-assigned port, on
 * loopback only.
 *
 * Nothing here may write to stdout: in the `mcp` command that stream carries the
 * MCP stdio protocol. Surface problems through the returned promise instead.
 */
import { createServer } from "node:http";
import express from "express";
import { WebSocketServer } from "ws";
import { createChannelConnection, type ProcessorRegistry } from "./channel";
import { defaultProcessors } from "./processors";

/** Forward prompt text into the Claude Code session. */
export type PromptHandler = (text: string) => void | Promise<void>;

export interface WebServerOptions {
  /** Called with text arriving over `POST /prompt` or from a stream processor. */
  onPrompt: PromptHandler;
  /**
   * Stream formats the websocket protocol accepts, keyed by the name clients
   * declare in their hello. Defaults to {@link defaultProcessors}.
   */
  processors?: ProcessorRegistry;
}

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
  // die with the connection, and concurrent clients never share state.
  const processors = options.processors ?? defaultProcessors();
  const wss = new WebSocketServer({ server: httpServer, path: "/ws" });
  wss.on("connection", (socket) => {
    const connection = createChannelConnection({ processors, sendPrompt: options.onPrompt });
    socket.on("message", async (data) => {
      const response = await connection.handleMessage(data.toString());
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
