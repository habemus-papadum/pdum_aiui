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
 * Binary frames keep audio/screenshot/video payloads raw (never base64'd). The
 * session bus (`/session`, see session-hub.ts) also gets a small HTTP surface —
 * `GET /session/peers` + `POST /session/publish` — so external tools on this
 * machine (the VS Code extension) can see the connected views and hand them a
 * contribution. It listens on an OS-assigned port, on loopback by default; the
 * launcher can bind it to the host interface instead ({@link WebServerOptions.host}
 * — the trusted-LAN posture that lets an iPad reach the paint surface, and
 * everything else, without a tunnel; see docs/guide/warning.md).
 *
 * Nothing here may write to stdout: in the `mcp` command that stream carries the
 * MCP stdio protocol. Surface problems through the returned promise instead.
 */
import { createServer } from "node:http";
import express from "express";
import { type RawData, type WebSocket, WebSocketServer } from "ws";
import { createChannelConnection, type FormatRegistry } from "./channel";
import { registerDebugRoutes } from "./debug";
import { ackEntry, createFrameLog, type FrameLogSink, inboundEntry, pushEntry } from "./frame-log";
import { defaultFormatLoader, type FormatLoader } from "./hot";
import type { LaunchInfo } from "./launch-info";
import { PageToolDirectory } from "./page-tools";
import { SessionHub } from "./session-hub";
import type { MountedSidecar, Sidecar } from "./sidecar";
import { createTransportStats } from "./stats";
import { createTraceStore, sessionLabel, type TraceStore } from "./trace";
import { withTracing } from "./tracing";

/**
 * Forward prompt text into the Claude Code session. The optional `meta` (from
 * the `intent-v1` lowering) becomes attributes on the rendered `<channel>` tag,
 * carrying Option-C attachment paths alongside the body tokens that reference
 * them. Text-only callers are unaffected.
 */
export type PromptHandler = (text: string, meta?: Record<string, string>) => void | Promise<void>;

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
   * The server's `--tag`, used only to name this process's trace **session
   * label** (see {@link sessionLabel}; untagged servers label as "channel").
   * Every trace stamped with the label, and `/debug/api/traces` reports it, so
   * trace lists can default-filter to this server's runs. Purely a human-facing
   * dimension — nothing routes on it.
   */
  tag?: string;
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
  /**
   * The session bus the `/session` websocket feeds — shared arming + prompt
   * preview + contributions across a session's tabs (see {@link SessionHub}).
   * Omitted, a fresh one is created (and returned on the handle).
   */
  sessionHub?: SessionHub;
  /**
   * How {@link WebServer.reload} obtains a fresh base (untraced) format registry
   * for each reload generation. Defaults to the hot loader (see hot.ts): a source
   * run re-imports the lowering layer from disk; a packaged run rebuilds from the
   * bundle. Tests inject a fake to drive the reload orchestration deterministically.
   * Ignored when {@link WebServerOptions.formats} is set — those formats are
   * caller-owned in-memory objects, not something to re-read from disk (a reload
   * then simply re-wraps them and cycles connections).
   */
  loadFormats?: FormatLoader;
  /**
   * Address to bind. Defaults to `127.0.0.1` — every channel route is
   * unauthenticated, so loopback is the safe posture. `0.0.0.0` is the
   * deliberate trusted-LAN choice (`aiui claude --aiui-bind host` /
   * `channel.bind: "host"`): the whole surface — prompt injection, `/debug`,
   * every sidecar (including the iPad paint page) — becomes reachable by
   * anyone on the network. See docs/guide/warning.md.
   */
  host?: string;
  /**
   * Server-level debug mode (the standalone `serve` command sets it). Surfaced
   * on `/health`, `/debug/api/info`, and every hello ack, so clients and tools
   * can tell they are talking to a debug server whose prompts never reach a
   * Claude Code session.
   */
  debug?: boolean;
  /**
   * Observes every frame-log entry as it is recorded (see frame-log.ts) — the
   * seam recording mode attaches its JSONL sink to (see recording.ts). The log
   * itself is always kept, sink or not.
   */
  frameSink?: FrameLogSink;
  /**
   * Fixed loopback port to bind. Defaults to 0 — an OS-assigned free port —
   * which is right everywhere a human isn't typing the URL by hand (registered
   * servers are discovered through the registry; parallel tests must never
   * collide). A caller that wants a *known* address (a pinned debug
   * channel, via `serve --port`) passes one, accepting that a taken port is a
   * loud `EADDRINUSE` rejection rather than a silent drift elsewhere.
   */
  port?: number;
  /**
   * Session sidecars to host alongside the channel's own endpoints — the code
   * reader, a git viewer (see {@link Sidecar}). Each is mounted on the Express
   * app under its own base path AFTER the channel's routes (so `/health`,
   * `/prompt` and the websocket upgrades always win), offered unclaimed
   * websocket upgrades, and disposed on {@link WebServer.close}. The launcher
   * chooses and constructs these; the channel treats them opaquely.
   */
  sidecars?: Sidecar[];
  /**
   * Log sink for server-level messages (sidecar mounts, etc.). Defaults to a
   * stderr writer — never stdout, which the `mcp` command's MCP protocol owns.
   */
  log?: (message: string) => void;
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

/** The outcome of a {@link WebServer.reload}. */
export interface ReloadSummary {
  reloaded: true;
  /** The reload counter after this reload (0 at startup, +1 per reload). */
  generation: number;
  /** How many live websockets were dropped (the clients reconnect on their own). */
  socketsDropped: number;
}

/** Reload the channel's lowering layer in place (see {@link WebServer.reload}). */
export type ChannelReload = () => Promise<ReloadSummary>;

export interface WebServer {
  /** The port the backend bound to (chosen by the OS). */
  port: number;
  /**
   * The page-tool registry the `/tools` websocket feeds. The MCP layer reads
   * and drives it; surfaced here so a caller that let the server create one can
   * still reach it.
   */
  pageTools: PageToolDirectory;
  /** The session bus the `/session` websocket feeds (see {@link SessionHub}). */
  sessionHub: SessionHub;
  /**
   * Reload the lowering layer in place: rebuild the format registry from freshly
   * (re-)loaded code, then drop every live websocket (they reconnect and
   * re-register on their own). The HTTP server, express app, and port never
   * bounce, and on-disk traces + launch info survive. Idempotent and safe to
   * call with zero connections (it just bumps the generation). If the fresh code
   * fails to load, the reload rejects and the running server is left untouched.
   */
  reload: ChannelReload;
  /** The current reload generation (0 at startup, +1 per successful reload). */
  getGeneration: () => number;
  /** Stop accepting connections and release the port. */
  close: () => Promise<void>;
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Start the web backend — on `127.0.0.1` unless {@link WebServerOptions.host}
 * widens it, an OS-assigned free port unless {@link WebServerOptions.port}
 * pins one — resolving once it's listening.
 */
export async function startWebServer(options: WebServerOptions): Promise<WebServer> {
  const app = express();
  const bindHost = options.host ?? "127.0.0.1";
  // Body parsing is scoped to the routes that need it (just `/prompt`), NOT
  // global: a sidecar's raw request handler (the reader reads its own POST
  // bodies off the stream) must reach the socket unconsumed.

  const pageTools = options.pageTools ?? new PageToolDirectory();
  const sessionHub = options.sessionHub ?? new SessionHub();

  const log =
    options.log ?? ((message: string) => process.stderr.write(`[aiui-channel] ${message}\n`));
  // Sidecars are mounted just before `listen` (so the channel's own routes win);
  // this list is populated by then and read by the upgrade handler below.
  const mountedSidecars: MountedSidecar[] = [];

  // Bumps on every successful reload; surfaced on /health and /debug/api/info so
  // a page or panel can tell it's talking to freshly-reloaded code.
  let generation = 0;

  app.get("/health", (_req, res) => {
    // Readable cross-origin: the dev overlay's tools bridge probes this route
    // from the app's dev-server origin before dialing `/tools` (the browser
    // logs failed websocket handshakes unsuppressably, so it never dials
    // blind). The payload is harmless loopback metadata, and the header's
    // presence is part of the capability signal — it ships together with the
    // `/tools` endpoint, so a CORS-refused probe means an older channel.
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.json({
      ok: true,
      pid: process.pid,
      ppid: process.ppid,
      generation,
      // The bound address, so tools can tell a loopback-only server from a
      // LAN-exposed one (`aiui paint url` decides which URLs to print by it).
      host: bindHost,
      pageTools: pageTools.summary(),
      session: sessionHub.summary(),
      ...(options.debug === true ? { debug: true } : {}),
    });
  });

  app.post("/prompt", express.json(), async (req, res) => {
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

  // The session bus's HTTP surface, for external same-host providers (the VS
  // Code extension) that contribute to the turn without holding a `/session`
  // socket of their own: `GET /session/peers` lists the connected views (so a
  // tool can offer "which browser tab?"), and `POST /session/publish` injects a
  // server-originated publish, targeted at one view (`clientId`), a role, or
  // everyone. Both report the cached `armed` slot so callers can phrase their
  // feedback; delivery is not gated on it — the overlay's contribution handler
  // arms the turn itself when a contribution lands.
  app.get("/session/peers", (_req, res) => {
    // Readable cross-origin for the same reason as /health: harmless loopback
    // metadata a debug page may want to render.
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.json({ ok: true, peers: sessionHub.peers(), armed: sessionHub.get("armed") === true });
  });

  app.post("/session/publish", express.json(), (req, res) => {
    const topic = typeof req.body?.topic === "string" ? req.body.topic : "";
    if (!topic) {
      res.status(400).json({ ok: false, error: "expected a non-empty 'topic' field" });
      return;
    }
    const clientId = typeof req.body?.clientId === "string" ? req.body.clientId : undefined;
    const role = typeof req.body?.role === "string" ? req.body.role : undefined;
    const delivered = sessionHub.publishFromServer(topic, req.body?.payload, {
      ...(clientId !== undefined ? { clientId } : {}),
      ...(role !== undefined ? { role } : {}),
    });
    if (delivered.length === 0) {
      const wanted =
        clientId !== undefined
          ? `view "${clientId}"`
          : role !== undefined
            ? `a "${role}" view`
            : "any connected view";
      res.status(404).json({ ok: false, error: `no connected session view matches ${wanted}` });
      return;
    }
    res.json({ ok: true, delivered, armed: sessionHub.get("armed") === true });
  });

  const httpServer = createServer(app);

  // Each websocket connection gets its own protocol state machine; its threads
  // die with the connection, and concurrent clients never share state. With a
  // traceDir, every thread also records a lowering trace and /debug serves the
  // viewer over them, plus the server-side transport counters.
  const stats = createTransportStats();

  // The protocol frame log (see frame-log.ts): every hello/chunk/ack/push in a
  // bounded ring, always recorded (it holds parsed JSON or byte counts, never
  // media bytes) and served at /debug/api/frames when the debug routes are on.
  const frameLog = createFrameLog(
    options.frameSink !== undefined ? { sink: options.frameSink } : {},
  );

  // The trace store is a long-lived singleton: created once, reused across every
  // reload so on-disk trace history survives. The format registry, by contrast,
  // is rebuilt on each reload (below) — its lowering code is what changes.
  // Creating the store is also where this process's session label is minted:
  // reloads swap code, not identity, so every trace of the server's lifetime
  // carries the same label.
  const traceStore: TraceStore | undefined = options.traceDir
    ? createTraceStore(options.traceDir, sessionLabel(options.tag))
    : undefined;

  // How each (re)load produces the base format registry. An explicit `formats`
  // registry is caller-owned in-memory state, so it can't be re-read from disk —
  // reload keeps returning it (still cycling sockets). Otherwise the hot loader
  // reloads the lowering layer from disk (source run) or the bundle (packaged).
  const loadFormats: FormatLoader =
    options.loadFormats ??
    (options.formats ? () => options.formats as FormatRegistry : defaultFormatLoader());

  // Rebuild the live registry for a generation: load the base formats, then
  // re-wrap tracing (a fresh wrap over the same singleton store).
  const buildFormats = async (gen: number): Promise<FormatRegistry> => {
    const base = await loadFormats(gen);
    return traceStore ? withTracing(base, traceStore) : base;
  };

  // The registry new connections read. Reassigned on reload; existing (dropped)
  // connections captured the old one.
  let formats = await buildFormats(generation);

  // Two websocket endpoints share one HTTP server: `/ws` (the binary
  // stream-processor protocol) and `/tools` (the JSON page-tool protocol). When
  // several `WebSocketServer`s attach via the `server` option they fight over
  // the upgrade, so both run in `noServer` mode and one upgrade listener routes
  // by path (anything else is dropped).
  // Every live socket (both endpoints), so reload can drop them all. Tracked
  // explicitly rather than via `wss.clients` because the `noServer` upgrade path
  // makes that set's membership less obvious to reason about.
  const liveSockets = new Set<WebSocket>();

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
      // Offer the upgrade to each sidecar (e.g. the reader's `/lsp`); the first to
      // claim it owns the socket. Nothing claims it → drop, as before. A sidecar
      // that throws mid-handshake is contained (logged, socket dropped) — one bad
      // sidecar must not sink the session.
      for (const sidecar of mountedSidecars) {
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
    liveSockets.add(socket);
    // A processor may push server → client messages (the `intent-v1` lowering
    // sends `lowered` events) out-of-band of the per-frame acks; the client
    // tells them apart by their `kind` field. Reads `formats` at connect time,
    // so a connection opened after a reload speaks the freshly loaded layer.
    const connection = createChannelConnection({
      formats,
      sendPrompt: options.onPrompt,
      push: (message) => {
        // Logged even if the socket already dropped: the push *happened* (the
        // frame log is the server's record, not the client's).
        frameLog.record(pushEntry(message));
        if (socket.readyState === socket.OPEN) {
          socket.send(JSON.stringify(message));
        }
      },
      ...(options.debug === true ? { debug: true } : {}),
    });
    socket.on("close", () => {
      liveSockets.delete(socket);
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

  // The `/tools` endpoint: a page declares its tool set as JSON text frames and
  // answers the calls the directory routes to it. Unlike `/ws` this is a plain
  // JSON protocol — the payloads are tiny schemas and results, not media.
  toolsWss.on("connection", (socket) => {
    liveSockets.add(socket);
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
    socket.on("close", () => {
      liveSockets.delete(socket);
      // Reload closes this socket, which drops the page's namespaces from the
      // directory; the bridge reconnects and re-registers them (invisibly, by hash).
      pageTools.removeConnection(clientId);
    });
    // A socket error is followed by `close`; swallow it so it doesn't crash the
    // process (Node treats an unhandled 'error' on the socket as fatal).
    socket.on("error", () => {});
  });

  // The `/session` endpoint: the multi-view session bus. Every tab of the session
  // (app, VS Code bridge, …) dials it; the hub relays shared arming + prompt preview
  // + contributions between them (see session-hub.ts). Plain JSON text frames.
  sessionWss.on("connection", (socket) => {
    liveSockets.add(socket);
    const clientId = sessionHub.addConnection((message) => {
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify(message));
      }
    });
    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        return; // the session protocol is JSON text only
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        return; // ignore garbage from a cooperative same-host client
      }
      sessionHub.handleClientMessage(clientId, parsed);
    });
    socket.on("close", () => {
      liveSockets.delete(socket);
      sessionHub.removeConnection(clientId);
    });
    socket.on("error", () => {});
  });

  // Reload the lowering layer in place. Order matters for robustness: build the
  // fresh registry FIRST — if the freshly edited code throws (a syntax error the
  // agent just introduced), we reject here and leave the running server, its
  // sockets, and the old registry untouched. Only once the rebuild succeeds do we
  // swap the registry, bump the generation, and drop live sockets. Each dropped
  // socket runs its normal close path (onClose thread teardown, directory entry
  // removal); the clients reconnect and re-register on their own.
  const reload: ChannelReload = async () => {
    const next = await buildFormats(generation + 1);
    generation += 1;
    formats = next;
    const dropping = [...liveSockets];
    liveSockets.clear();
    for (const socket of dropping) {
      try {
        // 1012 = "service restart": the standards-registered code for exactly this.
        socket.close(1012, "channel reload");
      } catch {
        // A socket already closing/closed just gets skipped.
      }
    }
    return { reloaded: true, generation, socketsDropped: dropping.length };
  };

  if (options.traceDir) {
    // Debug tool + JSON API (traces, this server's info, transport stats, the
    // frame log) plus the reload endpoint. Registered here, after `reload`
    // exists, so the route can drive it; the generation getter keeps
    // /debug/api/info's value live.
    registerDebugRoutes(app, options.traceDir, stats, options.launchInfo, {
      getGeneration: () => generation,
      onReload: reload,
      frameLog,
      // The store's session label rides along so the traces listing can say
      // which rows are this server's (a traceDir implies the store exists).
      ...(traceStore?.session !== undefined ? { session: traceStore.session } : {}),
      ...(options.debug === true ? { debug: true } : {}),
    });
  }

  // Mount sidecars LAST — after every channel route (`/health`, `/prompt`,
  // `/debug`) — so a sidecar's path-scoped fallback can never shadow them. Each
  // is isolated: a mount that throws is logged and skipped, never fatal.
  // `boundPort` is handed to them lazily: it resolves only after `listen`.
  let boundPort: number | undefined;
  for (const sidecar of options.sidecars ?? []) {
    try {
      mountedSidecars.push(await sidecar.mount(app, { log, port: () => boundPort }));
      log(`sidecar "${sidecar.name}" mounted`);
    } catch (err) {
      log(`sidecar "${sidecar.name}" failed to mount: ${errorMessage(err)}`);
    }
  }

  await new Promise<void>((resolveListen, rejectListen) => {
    httpServer.once("error", rejectListen);
    httpServer.listen(options.port ?? 0, bindHost, () => {
      httpServer.removeListener("error", rejectListen);
      resolveListen();
    });
  });

  const address = httpServer.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  boundPort = port;

  const close = async (): Promise<void> => {
    // Dispose sidecars first — let them kill spawned language servers / close a
    // Vite server before we release the port.
    await Promise.allSettled(mountedSidecars.map((s) => s.dispose?.()));
    await new Promise<void>((resolveClose) => {
      sessionWss.close(() =>
        toolsWss.close(() => wss.close(() => httpServer.close(() => resolveClose()))),
      );
    });
  };

  return { port, pageTools, sessionHub, reload, getGeneration: () => generation, close };
}
