/**
 * The aiui DevTools panel.
 *
 * Two data sources, four views:
 *  - **Server** — the channel server's own identity (`/debug/api/info`), a
 *    health-ping latency, and its transport counters (`/debug/api/stats`).
 *  - **Transport** — the *page's* view of the websocket: per-frame size + ack
 *    round-trip metrics recorded by `aiui-dev-overlay` into `window.__AIUI__`,
 *    read out of the inspected page via `chrome.devtools.inspectedWindow`.
 *  - **Traces** — the lowering-trace debugger, embedded from the server's
 *    `/debug` page (which remains usable standalone).
 *  - **Intent** — one chosen trace, live-followed through the shared `debug-ui`
 *    (loaded lazily from `./debug-ui.js`): the intent event stream, its IR
 *    passes, and per-segment timing, polled off `/debug/api/traces/:id/live`.
 *
 * Port discovery: the instrumented page publishes its channel port on
 * `window.__AIUI__.port` (set when the intent tool mounts). That's primary;
 * with no instrumented page the panel falls back to the most recently used port
 * (remembered in localStorage), and a manual field (or `?port=` query param)
 * always overrides. The panel also works opened as a plain tab.
 */
import {
  addRecentPort,
  channelBaseUrl,
  degradedKeyLine,
  filterTracesBySession,
  loadRecentPorts,
  saveRecentPorts,
  type TraceSummary,
  traceActorBadge,
  traceSessionLabel,
  traceSummaryLine,
} from "./intent-pane.js";
import { formatAgo, formatBytes, formatMs, summarizeRtt } from "./stats.js";

/** The shared debug UI, lazily imported (an esbuild bundle — see build-debug-ui.mjs). */
type DebugUiModule = typeof import("./debug-ui.js");

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
  /** The launcher's OpenAI-key preflight status (status only — never the key). */
  openaiKey?: string;
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
// A pinned port (a ?port= preset or a manual entry) sticks; the page's
// `window.__AIUI__.port` is otherwise primary, with remembered ports as the
// last-resort fallback (graduation handoff, port-discovery option a).
let portPinned = false;

const storage: Pick<Storage, "getItem" | "setItem"> | undefined =
  typeof localStorage !== "undefined" ? localStorage : undefined;
let recentPorts = loadRecentPorts(storage);

// Standalone conveniences: ?port= presets, the footer input overrides.
const queryPort = Number(new URLSearchParams(location.search).get("port"));
if (Number.isInteger(queryPort) && queryPort > 0) {
  port = queryPort;
  portPinned = true;
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

async function tickCore(): Promise<void> {
  const inst = await readPageInstrumentation();
  // The page's port is primary (unless the user pinned one); with no
  // instrumented page, fall back to the most recently used port.
  if (inst?.port && !portPinned) {
    port = inst.port;
  } else if (port === null && recentPorts.length) {
    port = recentPorts[0];
  }
  // The manual row shows whenever there's no page-provided port, so a
  // fallback/remembered port can always be overridden.
  $("port-row").hidden = Boolean(inst?.port);
  const portInput = $<HTMLInputElement>("port-input");
  if (document.activeElement !== portInput && port !== null) {
    portInput.value = String(port);
  }

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

  // A port that answered is worth remembering — but only persist when the
  // order actually changes (this runs every tick), i.e. it wasn't already first.
  if (recentPorts[0] !== port) {
    recentPorts = addRecentPort(recentPorts, port);
    saveRecentPorts(storage, recentPorts);
    renderPortRecents();
  }

  renderInfo(await fetchJson<Record<string, unknown>>("/debug/api/info"));
  renderServerStats(stats);
  renderClientFrames(inst);

  // Point the traces iframe at this server's /debug (once per port).
  if (tracesSrcFor !== port) {
    tracesSrcFor = port;
    $<HTMLIFrameElement>("traces-frame").src = `http://127.0.0.1:${port}/debug`;
  }
}

// ── intent pane (shared debug-ui, lazy) ──────────────────────────────────────
// The debug UI is an esbuild bundle loaded on demand, so a plain `tsc` build
// (the session-browser auto-rebuild) never breaks the other tabs — the Intent
// pane just degrades until `pnpm build` produces extension/js/debug-ui.js.
let debugUiMod: DebugUiModule | null | undefined;
async function loadDebugUi(): Promise<DebugUiModule | null> {
  if (debugUiMod === undefined) {
    debugUiMod = await import("./debug-ui.js").catch(() => null);
  }
  return debugUiMod;
}

let intentTraceId = "";
// The trace list defaults to the server's own session (the label riding on
// /debug/api/traces); the "all sessions" checkbox reveals earlier/other runs.
let intentAllSessions = false;
let intentKey = ""; // `${port}:${traceId}` — rebuild the follower when it changes
let intentPoll: ReturnType<DebugUiModule["createTracePoll"]> | null = null;
let traceView: InstanceType<DebugUiModule["TraceView"]> | null = null;

const renderPortRecents = (): void => {
  const list = document.getElementById("port-recents");
  if (list) {
    list.replaceChildren(
      ...recentPorts.map((p) => {
        const opt = document.createElement("option");
        opt.value = String(p);
        return opt;
      }),
    );
  }
};

const renderTraceOptions = (traces: TraceSummary[], showSessions: boolean): void => {
  const select = $<HTMLSelectElement>("intent-trace");
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = traces.length ? "— select a trace —" : "— no traces yet —";
  const options = [
    placeholder,
    ...traces.map((t) => {
      const opt = document.createElement("option");
      opt.value = t.id;
      // Non-human traces get a text badge next to the format ("[agent] …") —
      // <option>s are text-only, so the badge is part of the label. Under
      // "all sessions" the recording session's label is appended the same way
      // (the default view is single-session, so it would be noise there).
      const badge = traceActorBadge(t);
      const session = showSessions ? ` · ${traceSessionLabel(t)}` : "";
      opt.textContent = `${t.format}${badge ? ` ${badge}` : ""} · ${traceSummaryLine(t)}${session}`;
      opt.selected = t.id === intentTraceId;
      return opt;
    }),
  ];
  select.replaceChildren(...options);
  // A followed trace that aged out of the listing resets the selection.
  if (intentTraceId && !traces.some((t) => t.id === intentTraceId)) {
    intentTraceId = "";
  }
};

const clearIntentFollower = (): void => {
  intentKey = "";
  intentPoll = null;
  traceView = null;
  $("intent-view").replaceChildren();
};

async function updateIntent(): Promise<void> {
  if ($("tab-intent").hidden) {
    return;
  }
  const note = $("intent-note");
  if (port === null) {
    note.textContent = "Connect to a channel (Server tab) to follow intent traces.";
    clearIntentFollower();
    return;
  }
  const dbg = await loadDebugUi();
  if (!dbg) {
    note.textContent =
      "Intent debug UI isn't built — run: pnpm --filter @habemus-papadum/aiui-devtools-extension build";
    return;
  }
  const base = channelBaseUrl(port);

  const info = await fetchJson<{ launch?: LaunchInfoPayload }>("/debug/api/info");
  const degraded = degradedKeyLine(info?.launch?.openaiKey);

  // The listing rides with the server's own session label; default-filter the
  // picker to that session (see filterTracesBySession for the edge cases).
  const listing = await fetchJson<{ traces: TraceSummary[]; session?: string }>(
    "/debug/api/traces",
  );
  renderTraceOptions(
    filterTracesBySession(listing?.traces ?? [], listing?.session, intentAllSessions),
    intentAllSessions,
  );

  // Rebuild the poller + view whenever the port or selected trace changes.
  const key = `${port}:${intentTraceId}`;
  if (key !== intentKey) {
    clearIntentFollower();
    intentKey = key;
    if (intentTraceId) {
      intentPoll = dbg.createTracePoll({ baseUrl: base, traceId: intentTraceId });
      traceView = new dbg.TraceView({
        blobUrl: (id, file) =>
          `${base}/debug/blob/${encodeURIComponent(id)}/${encodeURIComponent(file)}`,
        previewUrl: (p) => `${base}/debug/api/preview?path=${encodeURIComponent(p)}`,
      });
      $("intent-view").replaceChildren(traceView.root);
    }
  }

  note.textContent = degraded ?? (intentTraceId ? "" : "Select a trace to follow it live.");

  if (intentPoll && traceView) {
    const result = await intentPoll.poll();
    if (result.changed && result.trace) {
      traceView.update(result.trace);
    }
  }
}

/** One poll cycle: the base panel plus the intent follower. */
async function tick(): Promise<void> {
  await tickCore();
  await updateIntent();
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
    // Render the Intent pane immediately on switch, not at the next poll tick.
    if (tab.dataset.tab === "intent") {
      void updateIntent();
    }
  });
}

$<HTMLInputElement>("port-input").addEventListener("change", (event) => {
  const value = Number((event.target as HTMLInputElement).value);
  port = Number.isInteger(value) && value > 0 ? value : null;
  portPinned = port !== null; // a manual entry sticks over page discovery
  void tick();
});

$<HTMLSelectElement>("intent-trace").addEventListener("change", (event) => {
  intentTraceId = (event.target as HTMLSelectElement).value;
  void updateIntent();
});
$<HTMLInputElement>("intent-all-sessions").addEventListener("change", (event) => {
  intentAllSessions = (event.target as HTMLInputElement).checked;
  void updateIntent();
});
$("intent-refresh").addEventListener("click", () => void updateIntent());

renderPortRecents();
void tick();
setInterval(() => void tick(), 1500);
