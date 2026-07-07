/**
 * The lowering debug tool: a small web app + JSON API served by the channel's
 * web backend, for inspecting the traces recorded by tracing.ts.
 *
 * Open `http://127.0.0.1:<port>/debug` (the intent tool's 🔍 button links
 * here). The app lists lowering runs newest-first; selecting one shows every
 * recorded stage — inputs as received, intermediate representations, and the
 * final lowered prompt — with image blobs rendered inline. This is the
 * compiler's `-emit-ir` for prompt lowering: when you disagree with how your
 * intent was rendered, this is where you find the stage that lost it.
 *
 * The generic stage viewer covers every modality; a modality can later ship a
 * richer, custom view (waveforms for audio, region overlays for screenshots) —
 * that per-format pluggability is designed but not yet built (the manifest
 * carries `format`, so the app knows what it's looking at).
 *
 * The inline `GET /debug` app below is the **dependency-free standalone
 * fallback** (works with nothing but this server — curl-able, no Vite). The
 * canonical trace debugger is the shared debug-ui viewer (the overlay
 * package's `TracesPane`/`TraceView`), served by the `aiuiDevOverlay()` Vite
 * plugin at `/__aiui/debug` — where the intent tool's 🔍 points — and embedded
 * by the DevTools extension and the workbench. Both speak the same
 * `/debug/api/*` routes; improvements should land in debug-ui first.
 *
 * Routes:
 *   GET /debug                      the viewer app (self-contained HTML)
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
 *                                   after seq N — the workbench's raw-JSON pane
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

  app.get("/debug", (_req, res) => {
    res.type("html").send(DEBUG_APP_HTML);
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

/** The viewer app: dependency-free HTML/CSS/JS in one string, dark themed. */
const DEBUG_APP_HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>aiui · lowering traces</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; display: flex; height: 100vh;
    background: #14171f; color: #e8e8ea;
    font: 13px/1.5 ui-sans-serif, system-ui, -apple-system, sans-serif;
  }
  #list {
    width: 300px; flex: none; overflow-y: auto;
    border-right: 1px solid #2a3140; padding: 10px;
  }
  #list h1 { font-size: 13px; margin: 4px 6px 6px; color: #9aa0aa; font-weight: 600; }
  #list .all-toggle {
    display: flex; align-items: center; gap: 6px; margin: 0 6px 10px;
    color: #9aa0aa; font-size: 11px; cursor: pointer; user-select: none;
  }
  #list .all-toggle input { margin: 0; accent-color: #8ab4f8; }
  .trace {
    padding: 8px 10px; border-radius: 8px; cursor: pointer; margin-bottom: 4px;
  }
  .trace:hover { background: #1f2430; }
  .trace.active { background: #2a3140; }
  .trace .fmt { font-weight: 600; }
  .trace .meta { color: #9aa0aa; font-size: 11px; }
  .actor {
    display: inline-block; margin-left: 6px; padding: 0 7px; border-radius: 999px;
    background: #3a2f14; color: #ffd166; font-size: 10px; font-weight: 600;
    vertical-align: 1px;
  }
  /* Deliberately dimmer than .actor: session is context, not provenance. */
  .session {
    display: inline-block; margin-left: 6px; padding: 0 7px; border-radius: 999px;
    background: #222836; color: #7d8695; font-size: 10px; vertical-align: 1px;
  }
  #detail { flex: 1; overflow-y: auto; padding: 18px 22px; }
  #detail .empty { color: #9aa0aa; margin-top: 40px; text-align: center; }
  .stage { margin-bottom: 14px; border: 1px solid #2a3140; border-radius: 10px; overflow: hidden; }
  .stage-head {
    display: flex; gap: 8px; align-items: baseline;
    padding: 6px 12px; background: #1f2430; font-size: 12px;
  }
  .kind { font-weight: 700; text-transform: uppercase; font-size: 10px; letter-spacing: .06em; }
  .kind.input  { color: #8ab4f8; }
  .kind.ir     { color: #d0a8ff; }
  .kind.output { color: #7ee0a3; }
  .kind.info   { color: #9aa0aa; }
  .stage-head .at { margin-left: auto; color: #9aa0aa; font-size: 11px; }
  .stage-body { padding: 10px 12px; }
  .stage-body pre {
    margin: 0; white-space: pre-wrap; word-break: break-word;
    font: 12px/1.5 ui-monospace, monospace;
  }
  .stage-body img { max-width: 100%; border-radius: 6px; }
  .stage-body a { color: #8ab4f8; }
  #detail h2 { font-size: 15px; margin: 0 0 2px; }
  #detail .sub { color: #9aa0aa; font-size: 12px; margin-bottom: 16px; }
  .path { color: #ffd166; border-bottom: 1px dotted #ffd16688; }
  .path.img { cursor: zoom-in; }
  #peek {
    position: fixed; z-index: 10; display: none; pointer-events: none;
    background: #1f2430; border: 1px solid #3a4152; border-radius: 8px; padding: 4px;
    box-shadow: 0 8px 30px #0009;
  }
  #peek img { display: block; max-width: 380px; max-height: 280px; border-radius: 5px; }
  #peek .peek-err { color: #9aa0aa; font-size: 11px; padding: 4px 6px; }
</style>
</head>
<body>
  <nav id="list"><h1>lowering traces</h1>
    <label class="all-toggle" title="include traces recorded by other/earlier server processes">
      <input type="checkbox" id="all-sessions"> all sessions</label>
    <div id="items"></div></nav>
  <main id="detail"><div class="empty">Select a trace — newest are first.<br>
    Send something from the intent tool to create one.</div></main>
<script>
const IMAGE = /\\.(png|jpe?g|gif|webp|svg)$/i;
// Absolute unix paths (>= one directory deep) inside prompt/stage text. The
// lowering convention hands the session attachments as absolute paths
// (archive/channel-attachment-path-encoding.md), so the debugger makes them
// tangible: highlighted, and — for images under the previewable roots —
// hover to peek, click to open.
const ABS_PATH = new RegExp("(^|[\\\\s\\"'({\\\\[=:,])(/(?:[\\\\w.@%+~-]+/)+[\\\\w.@%+~-]+)", "g");
let active = null;

// The session dimension: the listing reports which server process is serving
// it ("session"), and each manifest carries the label of the process that
// recorded it. The list defaults to this server's traces; the "all sessions"
// toggle reveals the rest — earlier runs, other servers on the same cache —
// each row then wearing a dim session pill ("unknown" for pre-label traces).
let session = null;
let allSessions = false;
const allToggle = document.getElementById("all-sessions");
allToggle.onchange = () => { allSessions = allToggle.checked; refresh(); };

const peek = document.createElement("div");
peek.id = "peek";
document.body.append(peek);
function previewUrl(path) { return "/debug/api/preview?path=" + encodeURIComponent(path); }
function showPeek(path, x, y) {
  peek.replaceChildren();
  const img = document.createElement("img");
  img.onerror = () => {
    const err = document.createElement("div");
    err.className = "peek-err";
    err.textContent = "no preview (outside the previewable roots, or gone)";
    peek.replaceChildren(err);
  };
  img.src = previewUrl(path);
  peek.append(img);
  peek.style.left = Math.min(x + 14, innerWidth - 400) + "px";
  peek.style.top = Math.min(y + 14, innerHeight - 300) + "px";
  peek.style.display = "block";
}
function hidePeek() { peek.style.display = "none"; }

// Render text with absolute paths wrapped in interactive spans.
function renderText(container, text) {
  let last = 0;
  ABS_PATH.lastIndex = 0;
  for (let m = ABS_PATH.exec(text); m; m = ABS_PATH.exec(text)) {
    const start = m.index + m[1].length;
    container.append(document.createTextNode(text.slice(last, start)));
    const path = m[2];
    const span = document.createElement("span");
    span.className = IMAGE.test(path) ? "path img" : "path";
    span.textContent = path;
    if (IMAGE.test(path)) {
      span.onmouseenter = (e) => showPeek(path, e.clientX, e.clientY);
      span.onmouseleave = hidePeek;
      span.onclick = () => window.open(previewUrl(path), "_blank");
    }
    container.append(span);
    last = start + path.length;
  }
  container.append(document.createTextNode(text.slice(last)));
}

async function refresh() {
  const res = await fetch("/debug/api/traces");
  const body = await res.json();
  session = body.session || null;
  // Default view: only this server's traces. A server that reports no label
  // (an older channel) can't be filtered against, so everything shows.
  const traces = (allSessions || session === null)
    ? body.traces
    : body.traces.filter((t) => t.session === session);
  // First load with traces present: jump straight to the newest one.
  if (!active && traces.length) { active = traces[0].id; show(active); }
  const items = document.getElementById("items");
  items.replaceChildren(...traces.map((t) => {
    const div = document.createElement("div");
    div.className = "trace" + (t.id === active ? " active" : "");
    div.onclick = () => { active = t.id; show(t.id); refresh(); };
    const fmt = document.createElement("div");
    fmt.className = "fmt"; fmt.textContent = t.format;
    // Provenance badge: non-human runs (agents, automation) get a pill so a
    // human scanning the list can tell their own turns from an agent's.
    if (t.actor && t.actor !== "human") {
      const pill = document.createElement("span");
      pill.className = "actor"; pill.textContent = t.actor;
      fmt.append(pill);
    }
    // Under "all sessions" every row says whose it is; the default view is
    // all-current-session, so the pill would be noise there.
    if (allSessions) {
      const pill = document.createElement("span");
      pill.className = "session"; pill.textContent = t.session || "unknown";
      fmt.append(pill);
    }
    const meta = document.createElement("div");
    meta.className = "meta";
    // The list route serves a slimmed manifest — stageCount in place of the full
    // stages array (see registerDebugRoutes). A one-line summary rides the
    // manifest when the turn was glossed; show it in place of the raw count.
    const n = t.stageCount != null ? t.stageCount : (t.stages ? t.stages.length : 0);
    meta.textContent = new Date(t.startedAt).toLocaleTimeString()
      + " · " + (t.summary ? t.summary : n + " stage" + (n === 1 ? "" : "s"))
      + (t.status ? " · " + t.status : " · live");
    div.append(fmt, meta);
    return div;
  }));
  if (!traces.length) items.innerHTML = '<div class="trace"><div class="meta">no traces '
    + (allSessions || session === null ? "yet" : "in this session yet") + '</div></div>';
}

async function show(id) {
  const res = await fetch("/debug/api/traces/" + encodeURIComponent(id));
  if (!res.ok) return;
  const t = await res.json();
  const main = document.getElementById("detail");
  const frag = document.createDocumentFragment();
  const h2 = document.createElement("h2");
  h2.textContent = t.format + " — " + t.id;
  const sub = document.createElement("div");
  sub.className = "sub";
  sub.textContent = "thread " + t.threadId
    + (t.actor ? " · actor " + t.actor : "")
    + " · started " + t.startedAt
    + (t.endedAt ? " · ended " + t.endedAt : " · live");
  frag.append(h2, sub);
  for (const s of t.stages) {
    const box = document.createElement("div"); box.className = "stage";
    const head = document.createElement("div"); head.className = "stage-head";
    const kind = document.createElement("span"); kind.className = "kind " + s.kind; kind.textContent = s.kind;
    const label = document.createElement("span"); label.textContent = s.label;
    const at = document.createElement("span"); at.className = "at";
    at.textContent = new Date(s.at).toLocaleTimeString();
    head.append(kind, label, at);
    const body = document.createElement("div"); body.className = "stage-body";
    if (s.file) {
      const url = "/debug/blob/" + encodeURIComponent(t.id) + "/" + encodeURIComponent(s.file);
      if (IMAGE.test(s.file)) {
        const img = document.createElement("img"); img.src = url; img.alt = s.label;
        body.append(img);
      } else {
        const a = document.createElement("a"); a.href = url; a.textContent = s.file;
        body.append(a);
      }
    } else if (s.data !== undefined) {
      const pre = document.createElement("pre");
      renderText(pre, typeof s.data === "string" ? s.data : JSON.stringify(s.data, null, 2));
      body.append(pre);
    }
    box.append(head, body);
    frag.append(box);
  }
  main.replaceChildren(frag);
}

refresh();
setInterval(refresh, 2000);
</script>
</body>
</html>
`;
