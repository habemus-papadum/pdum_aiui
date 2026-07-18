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
 * — the trusted-LAN posture that lets an iPad reach the pencil surface, and
 * everything else, without a tunnel; see docs/guide/warning.md).
 *
 * Nothing here may write to stdout: in the `mcp` command that stream carries the
 * MCP stdio protocol. Surface problems through the returned promise instead.
 */
import { createServer } from "node:http";
import express from "express";
import type { FormatRegistry } from "./channel";
import { registerDebugRoutes } from "./debug";
import { createFrameLog, type FrameLogSink } from "./frame-log";
import { defaultFormatLoader, type FormatLoader, isSourceRun } from "./hot";
import type { LaunchInfo } from "./launch-info";
import { PageToolDirectory } from "./page-tools";
import { SessionHub } from "./session-hub";
import type { Sidecar } from "./sidecar";
import { createTransportStats } from "./stats";
import { createTraceStore, sessionLabel, type TraceStageSink, type TraceStore } from "./trace";
import { registerChannelRoutes } from "./web-routes";
import { createChannelRuntime, errorMessage } from "./web-runtime";
import { attachChannelSockets } from "./web-sockets";

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
   * every sidecar (including the iPad pencil page) — becomes reachable by
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
   * Observes every lowering-trace **stage** as it is recorded (linter results,
   * cost, transcription outcomes, composed intents — the pipeline's own IRs),
   * across all threads. The one live seam for pipeline events that never reach
   * the frame log; the `mcp` command has no use for it (its client reads traces
   * over `/debug`), but the standalone `serve` command narrates a curated subset
   * to stderr. Requires {@link WebServerOptions.traceDir} — no store, no stages.
   * Best-effort: a throwing sink never breaks lowering (see {@link TraceStageSink}).
   */
  traceSink?: TraceStageSink;
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
   * Session sidecars to host alongside the channel's own endpoints — the
   * intent client, the pencil surface (see {@link Sidecar}). Each is mounted on
   * the Express app under its own base path AFTER the channel's routes (so
   * `/health`, `/prompt` and the websocket upgrades always win), offered
   * unclaimed websocket upgrades, and disposed on {@link WebServer.close}.
   * Callers default to the channel's own `standardSidecars` (see
   * standard-sidecars.ts); the channel still treats each one opaquely.
   */
  sidecars?: Sidecar[];
  /**
   * Dev vs. prod, handed to each sidecar as {@link SidecarContext.mode}. Defaults
   * to `isSourceRun()` — `"dev"` when the channel runs off `src/` (tsx), `"prod"`
   * from an installed `dist/` build. A web-serving sidecar reads it to pick a
   * Vite dev server (dev) or a prebuilt static bundle (prod); the launcher can
   * force it (`--mode`) to test the prod path in a source checkout.
   */
  mode?: "dev" | "prod";
  /**
   * Log sink for server-level messages (sidecar mounts, etc.). Defaults to a
   * stderr writer — never stdout, which the `mcp` command's MCP protocol owns.
   */
  log?: (message: string) => void;
}

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

/**
 * Start the web backend — on `127.0.0.1` unless {@link WebServerOptions.host}
 * widens it, an OS-assigned free port unless {@link WebServerOptions.port}
 * pins one — resolving once it's listening.
 */
export async function startWebServer(options: WebServerOptions): Promise<WebServer> {
  const app = express();
  const bindHost = options.host ?? "127.0.0.1";
  // Body parsing is scoped to the routes that need it (just `/prompt`), NOT
  // global: a sidecar's raw request handler (one that reads its own POST
  // bodies off the stream) must reach the socket unconsumed.

  const pageTools = options.pageTools ?? new PageToolDirectory();
  const sessionHub = options.sessionHub ?? new SessionHub();

  const log =
    options.log ?? ((message: string) => process.stderr.write(`[aiui-channel] ${message}\n`));

  // The trace store is a long-lived singleton: created once, reused across every
  // reload so on-disk trace history survives. The format registry, by contrast,
  // is rebuilt on each reload (inside the runtime) — its lowering code is what
  // changes. Creating the store is also where this process's session label is
  // minted: reloads swap code, not identity, so every trace of the server's
  // lifetime carries the same label.
  const traceStore: TraceStore | undefined = options.traceDir
    ? createTraceStore(options.traceDir, sessionLabel(options.tag), options.traceSink)
    : undefined;

  // How each (re)load produces the base format registry. An explicit `formats`
  // registry is caller-owned in-memory state, so it can't be re-read from disk —
  // reload keeps returning it (still cycling sockets). Otherwise the hot loader
  // reloads the lowering layer from disk (source run) or the bundle (packaged).
  const loadFormats: FormatLoader =
    options.loadFormats ??
    (options.formats ? () => options.formats as FormatRegistry : defaultFormatLoader());

  // The shared-mutable-state cluster (generation, the live format registry, the
  // live-socket set, the mounted sidecars held BY REFERENCE, and the post-listen
  // bound port), plus reload. The initial format load happens inside, so a broken
  // lowering layer fails fast at startup.
  const runtime = await createChannelRuntime({
    loadFormats,
    ...(traceStore !== undefined ? { traceStore } : {}),
  });

  registerChannelRoutes(app, {
    bindHost,
    onPrompt: options.onPrompt,
    pageTools,
    sessionHub,
    getGeneration: runtime.getGeneration,
    ...(options.debug === true ? { debug: true } : {}),
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

  // The channel's websocket surface: `/ws` (binary stream-processor protocol)
  // and the JSON `/tools` + `/session` hubs, behind one never-throw upgrade
  // router that offers unclaimed upgrades to the mounted sidecars. `closeAll`
  // preserves the sessionWss → toolsWss → wss teardown order.
  const sockets = attachChannelSockets(httpServer, {
    runtime,
    onPrompt: options.onPrompt,
    frameLog,
    stats,
    pageTools,
    sessionHub,
    log,
    ...(options.debug === true ? { debug: true } : {}),
  });

  if (options.traceDir) {
    // Debug tool + JSON API (traces, this server's info, transport stats, the
    // frame log) plus the reload endpoint. The runtime's `reload` is build-first/
    // swap-second (a broken fresh layer rejects and leaves the server untouched);
    // the generation getter keeps /debug/api/info's value live.
    registerDebugRoutes(app, options.traceDir, stats, options.launchInfo, {
      getGeneration: runtime.getGeneration,
      onReload: runtime.reload,
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
  // `mode` (dev/prod) defaults to whether the channel itself runs from source.
  const mode = options.mode ?? (isSourceRun() ? "dev" : "prod");
  for (const sidecar of options.sidecars ?? []) {
    try {
      runtime.mountedSidecars.push(
        await sidecar.mount(app, { mode, log, port: () => runtime.getBoundPort() }),
      );
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
  runtime.setBoundPort(port);

  const close = async (): Promise<void> => {
    // Dispose sidecars first — let them kill spawned language servers / close a
    // Vite server before we release the port.
    await Promise.allSettled(runtime.mountedSidecars.map((s) => s.dispose?.()));
    await new Promise<void>((resolveClose) => {
      sockets.closeAll(() => httpServer.close(() => resolveClose()));
    });
  };

  return {
    port,
    pageTools,
    sessionHub,
    reload: runtime.reload,
    getGeneration: runtime.getGeneration,
    close,
  };
}
