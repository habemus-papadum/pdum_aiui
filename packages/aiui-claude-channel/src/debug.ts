/**
 * The lowering debug API, served by the channel's web backend: the JSON/blob
 * routes a trace viewer polls to inspect the traces recorded by tracing.ts —
 * the compiler's `-emit-ir` for prompt lowering. When you disagree with how
 * your intent was rendered, a viewer over these routes is where you find the
 * stage that lost it.
 *
 * **The channel renders no HTML.** It is a data server; every page belongs to
 * a frontend process. The viewer is ONE shared implementation — the overlay
 * package's debug-ui (`TracesPane`/`TraceView`) — with three frontends:
 * `aiui debug` (a standalone Vite server with a channel switcher, fed by
 * GET /debug/api/channels), the `aiuiDevOverlay()` Vite plugin's
 * `/__aiui/debug` page (where the intent tool's 🔍 points), and the DevTools
 * extension's embedded panes. All of them speak the routes below; CORS is
 * open on `/debug` (loopback-only server) precisely so any local page can.
 *
 * Routes:
 *   GET /debug                      a JSON pointer at the viewers (no page)
 *   GET /debug/api/channels         every channel in this machine's registry
 *                                   (dead processes pruned), `self: true` on
 *                                   the answering one — how a viewer offers
 *                                   "switch channel" from one reachable port
 *   GET /debug/api/traces           all trace manifests, newest first, plus
 *                                   this server's `session` label (see
 *                                   trace.ts) so lists can default-filter to
 *                                   the current server's traces
 *   GET /debug/api/traces/:id       one manifest
 *   GET /debug/api/traces/:id/live  a revision-poll for live-following one
 *                                   trace: `{rev, ...manifest}`, or — when the
 *                                   caller passes `?since=<rev>` and nothing
 *                                   changed — `{unchanged:true, rev}`. `rev` is
 *                                   the manifest's mtime, which bumps on every
 *                                   stage (see trace.ts's flush-per-record).
 *   GET /debug/blob/:id/:file       a stage's blob file (image/text/binary)
 *   GET /debug/api/info             this server's own channel info (tag, port,
 *                                   pid, owning Claude session) plus, under
 *                                   `launch`, the launcher-provided session
 *                                   summary (see launch-info.ts), the live
 *                                   reload `generation`, this server's trace
 *                                   `session` label (the 🔍 deep-link source),
 *                                   and `debug: true` on a debug-mode server
 *   POST /debug/api/reload          reload the lowering layer in place (drops +
 *                                   reconnects live sockets); returns the reload
 *                                   summary. 404 when reload isn't wired.
 *   GET /debug/api/stats            server-side transport counters (see stats.ts)
 *   GET /debug/api/frames?since=N   the protocol frame log (see frame-log.ts):
 *                                   `{seq, entries}` with the entries recorded
 *                                   after seq N — a raw-JSON debug pane
 *                                   polls this with its last seen seq
 *   GET /debug/api/preview?path=…   an image from disk, for hover previews of
 *                                   absolute paths mentioned in lowered prompts
 *                                   (allowlisted roots only — see previewablePath)
 */
import { realpathSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, isAbsolute, join, sep } from "node:path";
import { cacheDir as userCacheDir } from "@habemus-papadum/aiui-util";
import type { Express } from "express";
import type { FrameLog } from "./frame-log";
import type { LaunchInfo } from "./launch-info";
import { listMcpServers } from "./list";
import type { TransportStats } from "./stats";
import { selfChannelInfo } from "./tools";
import { listTraces, readTrace, traceBlobPath } from "./trace";
import type { ChannelReload } from "./web";

const BLOB_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

/** How long a `/debug/api/info` result is reused before re-resolving. */
const INFO_CACHE_MS = 10_000;

/** Only images are previewable — anything else is never served. */
const PREVIEW_EXT = /\.(png|jpe?g|gif|webp|svg)$/i;

/**
 * Resolve a preview request to a servable file, or undefined.
 *
 * Lowered prompts reference attachments by **absolute path** (see
 * archive/channel-attachment-path-encoding.md — the session reads them with
 * its own tools), and the debug viewer wants to show those images on hover.
 * Serving arbitrary filesystem paths from a web endpoint is a real hole even
 * on loopback, so this is deliberately narrow: absolute, image extension, and
 * — after symlinks resolve — inside one of the `roots` where attachment blobs
 * legitimately live (the trace cache, the OS temp dir, the aiui user cache).
 * Everything else is a 404, with no reason disclosed.
 */
export function previewablePath(raw: string, roots: string[]): string | undefined {
  if (!raw || !isAbsolute(raw) || !PREVIEW_EXT.test(raw)) {
    return undefined;
  }
  let real: string;
  try {
    real = realpathSync(raw);
  } catch {
    return undefined; // missing file
  }
  for (const root of roots) {
    let realRoot: string;
    try {
      realRoot = realpathSync(root);
    } catch {
      continue;
    }
    if (real === realRoot || real.startsWith(realRoot + sep)) {
      return real;
    }
  }
  return undefined;
}

/** Trace ids/filenames the store ever writes match this (no path traversal). */
const SAFE_TRACE_ID = /^[\w.-]+$/;

/**
 * The current revision of a trace: its manifest's mtime in ms, or undefined if
 * the trace doesn't exist. trace.json is rewritten on every recorded stage, so
 * a rising mtime is a faithful "something changed" signal for live-following —
 * cheaper than reading/diffing the manifest each poll.
 */
function traceRev(cacheDir: string, id: string): number | undefined {
  if (!SAFE_TRACE_ID.test(id)) {
    return undefined;
  }
  try {
    return statSync(join(cacheDir, "traces", id, "trace.json")).mtimeMs;
  } catch {
    return undefined;
  }
}

/** Live server state the web backend threads into the debug API. */
export interface DebugHooks {
  /** Reads the current reload generation, for /debug/api/info. */
  getGeneration?: () => number;
  /** Drives a reload for POST /debug/api/reload; omit and the route 404s. */
  onReload?: ChannelReload;
  /** The server's protocol frame log, for GET /debug/api/frames. */
  frameLog?: FrameLog;
  /**
   * This server process's trace session label (see {@link sessionLabel} in
   * trace.ts), reported alongside the listing on GET /debug/api/traces.
   */
  session?: string;
  /** True on a debug-mode server (`serve`); echoed on /debug/api/info. */
  debug?: boolean;
}

/** Mount the debug tool's routes onto the backend's express app. */
export function registerDebugRoutes(
  app: Express,
  cacheDir: string,
  stats?: TransportStats,
  launchInfo?: LaunchInfo,
  hooks: DebugHooks = {},
): void {
  // Loopback diagnostics: let any local page (the DevTools panel opened as a
  // plain tab, test fixtures) read these endpoints cross-origin. The server
  // only listens on 127.0.0.1, so this widens nothing beyond the machine.
  app.use("/debug", (_req, res, next) => {
    res.setHeader("access-control-allow-origin", "*");
    next();
  });

  // The channel renders no HTML — it is a JSON/data server (the rule; /health
  // and friends are messages, not pages). The viewer is the shared debug-ui
  // app: `aiui debug` serves it standalone, the aiuiDevOverlay() Vite plugin
  // serves it at /__aiui/debug, and the DevTools panel embeds it. A GET here
  // (an old bookmark, a curious curl) gets a pointer, not a page.
  app.get("/debug", (_req, res) => {
    res.json({
      ui: "the channel serves no HTML — run `aiui debug` (or open /__aiui/debug on your app's dev server)",
      api: [
        "/debug/api/info",
        "/debug/api/channels",
        "/debug/api/traces",
        "/debug/api/traces/:id",
        "/debug/api/traces/:id/live",
        "/debug/api/frames?since=N",
        "/debug/api/stats",
        "/debug/blob/:id/:file",
      ],
    });
  });

  // Every channel this machine is running (the on-disk registry, pruned of
  // dead processes) — how a connected debug viewer offers "switch channel":
  // one reachable channel is enough to enumerate and hop to all the others.
  app.get("/debug/api/channels", (_req, res) => {
    res.json({
      channels: listMcpServers().map((server) => ({
        tag: server.tag,
        port: server.port,
        pid: server.pid,
        ppid: server.ppid,
        cwd: server.cwd,
        startedAt: server.startedAt,
        ...(server.name !== undefined ? { name: server.name } : {}),
        ...(server.debug === true ? { debug: true } : {}),
        ...(server.pid === process.pid ? { self: true } : {}),
      })),
    });
  });

  // selfChannelInfo shells out to `claude agents --json`; cache it so a
  // polling panel doesn't spawn a subprocess per tick. The launch info rides
  // along verbatim — it's static for the server's lifetime.
  let infoCache: { at: number; value: ReturnType<typeof selfChannelInfo> } | undefined;
  app.get("/debug/api/info", (_req, res) => {
    if (!infoCache || Date.now() - infoCache.at > INFO_CACHE_MS) {
      infoCache = { at: Date.now(), value: selfChannelInfo() };
    }
    // The generation is read fresh each request (it's outside the info cache) so
    // a panel polling /debug/api/info sees a reload the moment it lands.
    res.json({
      ...infoCache.value,
      ...(launchInfo ? { launch: launchInfo } : {}),
      ...(hooks.getGeneration ? { generation: hooks.getGeneration() } : {}),
      // This server's trace session label — how the intent tool's 🔍 builds
      // its `?session=` deep link without pulling the whole traces listing.
      ...(hooks.session !== undefined ? { session: hooks.session } : {}),
      ...(hooks.debug === true ? { debug: true } : {}),
    });
  });

  // Reload the lowering layer in place — the DevTools panel's button and `curl`
  // both POST here. CORS is already open on /debug above.
  app.post("/debug/api/reload", async (_req, res) => {
    if (!hooks.onReload) {
      res.status(404).json({ error: "reload not available" });
      return;
    }
    try {
      res.json(await hooks.onReload());
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // The protocol frame log (see frame-log.ts). A poller echoes the last `seq`
  // it saw as `?since=` and receives only what's new; no `since` (or a bad
  // one) returns everything still in the ring.
  app.get("/debug/api/frames", (req, res) => {
    if (!hooks.frameLog) {
      res.status(404).json({ error: "frame log not enabled" });
      return;
    }
    const since = typeof req.query.since === "string" ? Number(req.query.since) : Number.NaN;
    res.json(hooks.frameLog.snapshot(Number.isFinite(since) ? since : 0));
  });

  app.get("/debug/api/stats", (_req, res) => {
    if (!stats) {
      res.status(404).json({ error: "transport stats not enabled" });
      return;
    }
    res.json(stats.snapshot());
  });

  // Hover previews for absolute image paths mentioned in prompts/stages.
  const previewRoots = [cacheDir, tmpdir(), userCacheDir(undefined, { create: false })];
  app.get("/debug/api/preview", async (req, res) => {
    const raw = typeof req.query.path === "string" ? req.query.path : "";
    const file = previewablePath(raw, previewRoots);
    if (!file) {
      res.status(404).json({ error: "not previewable" });
      return;
    }
    try {
      const bytes = await readFile(file);
      res.type(BLOB_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream").send(bytes);
    } catch {
      res.status(404).json({ error: "not previewable" });
    }
  });

  app.get("/debug/api/traces", (_req, res) => {
    // The current session label rides with the listing (additive) so viewers
    // can split "this server's traces" from earlier/other processes' — the
    // manifests all live flat in one cache dir.
    //
    // Slim each manifest to a `stageCount`: this route is polled every ~2 s and
    // a single voice turn records one stage *per audio frame* (hundreds), so
    // returning full `stages` for every trace made the listing megabytes of
    // payload the list never reads. Follow views fetch the whole manifest from
    // `/debug/api/traces/:id[/live]`; the list only needs the count (and the
    // `summary`, which rides untouched with the rest of the manifest fields).
    const traces = listTraces(cacheDir).map(({ stages, ...rest }) => ({
      ...rest,
      stageCount: stages.length,
    }));
    res.json({
      traces,
      ...(hooks.session !== undefined ? { session: hooks.session } : {}),
    });
  });

  app.get("/debug/api/traces/:id", (req, res) => {
    const trace = readTrace(cacheDir, req.params.id);
    if (!trace) {
      res.status(404).json({ error: "no such trace" });
      return;
    }
    res.json(trace);
  });

  // Live-follow one trace with a cheap revision poll (the DevTools panel's
  // Intent pane, the lab). `rev` is the manifest file's mtime — trace.ts
  // rewrites the whole manifest on every recorded stage, so mtime advances
  // with the run. A client echoes the last `rev` as `?since=`; when it still
  // matches we answer `{unchanged:true}` (a handful of bytes) instead of
  // re-sending the whole manifest. CORS is already open on `/debug` above.
  app.get("/debug/api/traces/:id/live", (req, res) => {
    const rev = traceRev(cacheDir, req.params.id);
    if (rev === undefined) {
      res.status(404).json({ error: "no such trace" });
      return;
    }
    const since = typeof req.query.since === "string" ? Number(req.query.since) : Number.NaN;
    if (Number.isFinite(since) && since === rev) {
      res.json({ unchanged: true, rev });
      return;
    }
    const trace = readTrace(cacheDir, req.params.id);
    if (!trace) {
      res.status(404).json({ error: "no such trace" });
      return;
    }
    res.json({ rev, ...trace });
  });

  app.get("/debug/blob/:id/:file", async (req, res) => {
    const path = traceBlobPath(cacheDir, req.params.id, req.params.file);
    if (!path) {
      res.status(400).json({ error: "bad name" });
      return;
    }
    try {
      const bytes = await readFile(path);
      res.type(BLOB_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream").send(bytes);
    } catch {
      res.status(404).json({ error: "no such blob" });
    }
  });
}
