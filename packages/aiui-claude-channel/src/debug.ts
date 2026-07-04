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
 * Routes:
 *   GET /debug                      the viewer app (self-contained HTML)
 *   GET /debug/api/traces           all trace manifests, newest first
 *   GET /debug/api/traces/:id       one manifest
 *   GET /debug/blob/:id/:file       a stage's blob file (image/text/binary)
 *   GET /debug/api/info             this server's own channel info (tag, port,
 *                                   pid, owning Claude session) plus, under
 *                                   `launch`, the launcher-provided session
 *                                   summary (see launch-info.ts)
 *   GET /debug/api/stats            server-side transport counters (see stats.ts)
 */
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import type { Express } from "express";
import type { LaunchInfo } from "./launch-info";
import type { TransportStats } from "./stats";
import { selfChannelInfo } from "./tools";
import { listTraces, readTrace, traceBlobPath } from "./trace";

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

/** Mount the debug tool's routes onto the backend's express app. */
export function registerDebugRoutes(
  app: Express,
  cacheDir: string,
  stats?: TransportStats,
  launchInfo?: LaunchInfo,
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
    res.json(launchInfo ? { ...infoCache.value, launch: launchInfo } : infoCache.value);
  });

  app.get("/debug/api/stats", (_req, res) => {
    if (!stats) {
      res.status(404).json({ error: "transport stats not enabled" });
      return;
    }
    res.json(stats.snapshot());
  });

  app.get("/debug/api/traces", (_req, res) => {
    res.json({ traces: listTraces(cacheDir) });
  });

  app.get("/debug/api/traces/:id", (req, res) => {
    const trace = readTrace(cacheDir, req.params.id);
    if (!trace) {
      res.status(404).json({ error: "no such trace" });
      return;
    }
    res.json(trace);
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
  #list h1 { font-size: 13px; margin: 4px 6px 10px; color: #9aa0aa; font-weight: 600; }
  .trace {
    padding: 8px 10px; border-radius: 8px; cursor: pointer; margin-bottom: 4px;
  }
  .trace:hover { background: #1f2430; }
  .trace.active { background: #2a3140; }
  .trace .fmt { font-weight: 600; }
  .trace .meta { color: #9aa0aa; font-size: 11px; }
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
</style>
</head>
<body>
  <nav id="list"><h1>lowering traces</h1><div id="items"></div></nav>
  <main id="detail"><div class="empty">Select a trace — newest are first.<br>
    Send something from the intent tool to create one.</div></main>
<script>
const IMAGE = /\\.(png|jpe?g|gif|webp|svg)$/i;
let active = null;

async function refresh() {
  const res = await fetch("/debug/api/traces");
  const { traces } = await res.json();
  // First load with traces present: jump straight to the newest one.
  if (!active && traces.length) { active = traces[0].id; show(active); }
  const items = document.getElementById("items");
  items.replaceChildren(...traces.map((t) => {
    const div = document.createElement("div");
    div.className = "trace" + (t.id === active ? " active" : "");
    div.onclick = () => { active = t.id; show(t.id); refresh(); };
    const fmt = document.createElement("div");
    fmt.className = "fmt"; fmt.textContent = t.format;
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = new Date(t.startedAt).toLocaleTimeString()
      + " · " + t.stages.length + " stage" + (t.stages.length === 1 ? "" : "s")
      + (t.status ? " · " + t.status : " · live");
    div.append(fmt, meta);
    return div;
  }));
  if (!traces.length) items.innerHTML = '<div class="trace"><div class="meta">no traces yet</div></div>';
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
  sub.textContent = "thread " + t.threadId + " · started " + t.startedAt
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
      pre.textContent = typeof s.data === "string" ? s.data : JSON.stringify(s.data, null, 2);
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
