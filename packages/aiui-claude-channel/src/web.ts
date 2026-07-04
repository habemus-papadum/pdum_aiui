/**
 * The channel server's web backend.
 *
 * A small HTTP + WebSocket server the outside world uses to push text into the
 * Claude Code session behind this MCP server. Today it exposes a health check,
 * a `POST /prompt` that forwards its `text` to the session, and a `/ws`
 * websocket that does the same per message — enough to drive an end-to-end
 * test, and the foundation for richer routes later. It listens on an
 * OS-assigned port, on loopback only.
 *
 * Nothing here may write to stdout: in the `mcp` command that stream carries the
 * MCP stdio protocol. Surface problems through the returned promise instead.
 */
import { createServer } from "node:http";
import express from "express";
import { WebSocketServer } from "ws";

/** Forward prompt text into the Claude Code session. */
export type PromptHandler = (text: string) => void | Promise<void>;

export interface WebServerOptions {
  /** Called with text arriving over `POST /prompt` or a websocket message. */
  onPrompt: PromptHandler;
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

  const wss = new WebSocketServer({ server: httpServer, path: "/ws" });
  wss.on("connection", (socket) => {
    socket.on("message", async (data) => {
      const text = data.toString();
      try {
        await options.onPrompt(text);
        socket.send(JSON.stringify({ ok: true }));
      } catch (err) {
        socket.send(JSON.stringify({ ok: false, error: errorMessage(err) }));
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
