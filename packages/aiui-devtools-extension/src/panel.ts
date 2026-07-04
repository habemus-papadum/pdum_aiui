/**
 * The aiui DevTools panel.
 *
 * Two data sources, three views:
 *  - **Server** — the channel server's own identity (`/debug/api/info`), a
 *    health-ping latency, and its transport counters (`/debug/api/stats`).
 *  - **Transport** — the *page's* view of the websocket: per-frame size + ack
 *    round-trip metrics recorded by `aiui-dev-overlay` into `window.__AIUI__`,
 *    read out of the inspected page via `chrome.devtools.inspectedWindow`.
 *  - **Traces** — the lowering-trace debugger, embedded from the server's
 *    `/debug` page (which remains usable standalone).
 *
 * Port discovery: the instrumented page publishes its channel port on
 * `window.__AIUI__.port` (set when the intent tool mounts). Outside DevTools —
 * the panel also works opened as a plain tab — or when no instrumented page is
 * found, a manual port field (or `?port=` query param) takes over.
 */
import { formatAgo, formatBytes, formatMs, summarizeRtt } from "./stats.js";

/** Mirror of aiui-dev-overlay's FrameMetric (the window.__AIUI__ wire shape, v1). */
interface PageFrame {
  at: number;
  format: string;
  kind: string;
  threadId?: string;
  fin?: boolean;
  bytes: number;
  rttMs: number;
  ok: boolean;
  error?: string;
}
interface PageInstrumentation {
  v: number;
  port?: number;
  frames: PageFrame[];
}

/** Mirrors of the channel server's /debug/api payloads. */
interface LaunchChromeDevtools {
  enabled: boolean;
  connection?: string;
  browserUrl?: string;
  userDataDir?: string;
  executablePath?: string;
  channel?: string;
  headless?: boolean;
  extensionDir?: string;
}
interface LaunchInfoPayload {
  launcher?: string;
  chromeDevtools?: LaunchChromeDevtools;
}
interface ServerFrame {
  at: string;
  bytes: number;
  processMs: number;
  ok: boolean;
  threadId?: string;
  closed?: boolean;
}
interface ServerStats {
  startedAt: string;
  connections: { total: number; active: number };
  frames: { count: number; bytes: number };
  recent: ServerFrame[];
}

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

const inDevtools = typeof chrome !== "undefined" && chrome.devtools?.inspectedWindow !== undefined;

/** Evaluate an expression in the inspected page; null outside DevTools. */
const evalInPage = (expr: string): Promise<string | null> =>
  new Promise((resolve) => {
    if (!inDevtools) {
      resolve(null);
      return;
    }
    chrome.devtools.inspectedWindow.eval(expr, (result) => {
      resolve(typeof result === "string" ? result : null);
    });
  });

async function readPageInstrumentation(): Promise<PageInstrumentation | null> {
  const raw = await evalInPage("JSON.stringify(window.__AIUI__ || null)");
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as PageInstrumentation | null;
    return parsed && parsed.v === 1 && Array.isArray(parsed.frames) ? parsed : null;
  } catch {
    return null;
  }
}

// ── state ────────────────────────────────────────────────────────────────────
let port: number | null = null;
let tracesSrcFor: number | null = null;

// Standalone conveniences: ?port= presets, the footer input overrides.
const queryPort = Number(new URLSearchParams(location.search).get("port"));
if (Number.isInteger(queryPort) && queryPort > 0) {
  port = queryPort;
}

// ── rendering ────────────────────────────────────────────────────────────────
const setStatus = (text: string, ok: boolean | null): void => {
  const el = $("status");
  el.textContent = text;
  el.className = ok === null ? "" : ok ? "ok" : "bad";
};

const card = (value: string, label: string): HTMLElement => {
  const div = document.createElement("div");
  div.className = "card";
  const v = document.createElement("div");
  v.className = "v";
  v.textContent = value;
  const k = document.createElement("div");
  k.className = "k";
  k.textContent = label;
  div.append(v, k);
  return div;
};

const renderInfo = (info: Record<string, unknown> | null): void => {
  const dl = $("info");
  dl.replaceChildren();
  if (!info) {
    return;
  }
  const rows: Array<[string, string]> = [];
  for (const key of ["tag", "port", "pid", "ppid", "cwd", "startedAt"]) {
    if (info[key] !== undefined) {
      rows.push([key, String(info[key])]);
    }
  }
  const session = info.session as Record<string, unknown> | undefined;
  if (session) {
    rows.push(["session", `${session.name} (${session.status})`]);
    rows.push(["sessionId", String(session.sessionId)]);
  }
  if (info.registered === false) {
    rows.push(["registered", "no — server not (yet) in the registry"]);
  }
  // How the launcher wired the session (see the channel's launch-info.ts):
  // the first thing to check when the agent's browser tooling misbehaves.
  const launch = info.launch as LaunchInfoPayload | undefined;
  if (launch?.launcher) {
    rows.push(["launcher", launch.launcher]);
  }
  const chrome = launch?.chromeDevtools;
  if (chrome) {
    rows.push([
      "devtools mcp",
      !chrome.enabled
        ? "off"
        : chrome.connection === "attach"
          ? `attach · ${chrome.browserUrl ?? "(endpoint unknown)"}`
          : "launch — MCP-private browser, started on first tool use",
    ]);
    if (chrome.enabled) {
      const browser =
        chrome.executablePath ?? (chrome.channel && `installed Chrome (${chrome.channel})`);
      if (browser) {
        rows.push(["browser", browser + (chrome.headless ? " · headless" : "")]);
      }
      if (chrome.userDataDir) {
        rows.push(["browser profile", chrome.userDataDir]);
      }
      if (chrome.extensionDir) {
        rows.push(["panel auto-load", chrome.extensionDir]);
      }
    }
  }
  for (const [k, v] of rows) {
    const dt = document.createElement("dt");
    dt.textContent = k;
    const dd = document.createElement("dd");
    dd.textContent = v;
    dl.append(dt, dd);
  }
};

const headerRow = (cells: Array<[string, boolean]>): HTMLTableRowElement => {
  const tr = document.createElement("tr");
  for (const [text, numeric] of cells) {
    const th = document.createElement("th");
    th.textContent = text;
    if (numeric) {
      th.className = "num";
    }
    tr.append(th);
  }
  return tr;
};

const cell = (text: string, className = ""): HTMLTableCellElement => {
  const td = document.createElement("td");
  td.textContent = text;
  td.className = className;
  return td;
};

const renderServerStats = (stats: ServerStats | null): void => {
  const cards = $("server-cards");
  const table = $("server-frames");
  cards.replaceChildren();
  table.replaceChildren();
  if (!stats) {
    return;
  }
  cards.append(
    card(String(stats.connections.active), "active conns"),
    card(String(stats.connections.total), "total conns"),
    card(String(stats.frames.count), "frames in"),
    card(formatBytes(stats.frames.bytes), "bytes in"),
  );
  table.append(
    headerRow([
      ["when", false],
      ["thread", false],
      ["bytes", true],
      ["process", true],
      ["result", false],
    ]),
  );
  const now = Date.now();
  for (const f of [...stats.recent].reverse().slice(0, 25)) {
    const tr = document.createElement("tr");
    tr.append(
      cell(formatAgo(Date.parse(f.at), now)),
      cell(f.threadId ? f.threadId.slice(0, 8) : "—", "mono"),
      cell(formatBytes(f.bytes), "num"),
      cell(formatMs(f.processMs), "num"),
      cell(f.ok ? (f.closed ? "ok · closed" : "ok") : "error", f.ok ? "ok-cell" : "err-cell"),
    );
    table.append(tr);
  }
};

const renderClientFrames = (inst: PageInstrumentation | null): void => {
  const cards = $("client-cards");
  const table = $("client-frames");
  const hint = $("transport-hint");
  cards.replaceChildren();
  table.replaceChildren();
  if (!inst || inst.frames.length === 0) {
    hint.textContent = inDevtools
      ? "No frames measured yet in the inspected page — send something from the intent tool."
      : "Page-side metrics need DevTools (they're read out of the inspected page). Open this panel from the aiui tab in Chrome DevTools.";
    return;
  }
  hint.textContent = "";
  const rtt = summarizeRtt(inst.frames.map((f) => f.rttMs));
  const bytes = inst.frames.reduce((acc, f) => acc + f.bytes, 0);
  cards.append(
    card(String(inst.frames.length), "frames sent"),
    card(formatBytes(bytes), "bytes sent"),
  );
  if (rtt) {
    cards.append(
      card(formatMs(rtt.avgMs), "avg ack rtt"),
      card(formatMs(rtt.p50Ms), "p50"),
      card(formatMs(rtt.p95Ms), "p95"),
    );
  }
  table.append(
    headerRow([
      ["when", false],
      ["kind", false],
      ["format", false],
      ["thread", false],
      ["bytes", true],
      ["rtt", true],
      ["result", false],
    ]),
  );
  const now = Date.now();
  for (const f of [...inst.frames].reverse().slice(0, 25)) {
    const tr = document.createElement("tr");
    tr.append(
      cell(formatAgo(f.at, now)),
      cell(f.kind + (f.fin ? " · fin" : "")),
      cell(f.format, "mono"),
      cell(f.threadId ? f.threadId.slice(0, 8) : "—", "mono"),
      cell(formatBytes(f.bytes), "num"),
      cell(formatMs(f.rttMs), "num"),
      cell(f.ok ? "ok" : (f.error ?? "error"), f.ok ? "ok-cell" : "err-cell"),
    );
    table.append(tr);
  }
};

// ── polling ──────────────────────────────────────────────────────────────────
const fetchJson = async <T>(path: string): Promise<T | null> => {
  if (port === null) {
    return null;
  }
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`);
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
};

async function tick(): Promise<void> {
  const inst = await readPageInstrumentation();
  if (inst?.port && port === null) {
    port = inst.port;
  }
  $("port-row").hidden = !(port === null && !inst?.port);

  if (port === null) {
    setStatus(
      inDevtools ? "no channel found in this page yet" : "enter a channel port below",
      null,
    );
    renderClientFrames(inst);
    return;
  }

  // The stats fetch doubles as the server latency ping: it's an in-memory
  // snapshot (cheap) and — unlike /health — CORS-readable in standalone mode.
  const pingStart = performance.now();
  const stats = await fetchJson<ServerStats>("/debug/api/stats");
  const pingMs = performance.now() - pingStart;
  if (!stats) {
    setStatus(`port ${port} unreachable`, false);
    renderInfo(null);
    renderServerStats(null);
    renderClientFrames(inst);
    return;
  }
  setStatus(`port ${port} · ping ${formatMs(pingMs)}`, true);

  renderInfo(await fetchJson<Record<string, unknown>>("/debug/api/info"));
  renderServerStats(stats);
  renderClientFrames(inst);

  // Point the traces iframe at this server's /debug (once per port).
  if (tracesSrcFor !== port) {
    tracesSrcFor = port;
    $<HTMLIFrameElement>("traces-frame").src = `http://127.0.0.1:${port}/debug`;
  }
}

// ── wiring ───────────────────────────────────────────────────────────────────
for (const tab of document.querySelectorAll<HTMLButtonElement>(".tab")) {
  tab.addEventListener("click", () => {
    for (const other of document.querySelectorAll<HTMLButtonElement>(".tab")) {
      other.classList.toggle("active", other === tab);
    }
    for (const section of document.querySelectorAll<HTMLElement>("main > section")) {
      section.hidden = section.id !== `tab-${tab.dataset.tab}`;
    }
  });
}

$<HTMLInputElement>("port-input").addEventListener("change", (event) => {
  const value = Number((event.target as HTMLInputElement).value);
  port = Number.isInteger(value) && value > 0 ? value : null;
  void tick();
});

void tick();
setInterval(() => void tick(), 1500);
