/**
 * The workbench: the full intent pipeline with **no agent on the other end**.
 *
 * Layout: the left half hosts a real app (pluggable — see apps.ts), the right
 * half is trace instrumentation. The page mounts the *shipping* intent overlay
 * (arm with `` ` ``, talk, ink, shoot, K for tiers — nothing lab-specific), and
 * every turn streams to a **debug channel server this dev server owns** (see
 * vite.config.ts): real transcription, real corrections, real lowering, real
 * traces — but structurally incapable of reaching a Claude session. The final
 * lowered prompt comes back over the websocket instead, so the payoff is
 * *inspection*: watch the raw frames, the trace stages, and the prompt that
 * would have been injected, without ever triggering an agent.
 *
 * The dock is the shared debug-ui {@link TraceView} — the same component the
 * DevTools extension embeds — so improving it improves every host at once. It
 * used to carry three tabs (Trace / Raw frames / Prompt); the trace view now
 * subsumes all three (per-frame wire data lives in the trace stages, and the
 * final prompt is the selected trace's hero), so the dock is a single pane.
 */
import { mountIntentTool, unmountIntentTool } from "@habemus-papadum/aiui-dev-overlay";
import { TracesPane } from "@habemus-papadum/aiui-dev-overlay/debug-ui";
import { WORKBENCH_APPS, type WorkbenchApp, type WorkbenchAppContext } from "./apps";
import { STYLES } from "./styles";

const APP_STORAGE_KEY = "aiui-workbench-app";

const style = document.createElement("style");
style.textContent = STYLES;
document.head.append(style);

// ── the shell ────────────────────────────────────────────────────────────────
document.body.innerHTML = `
  <div id="wb-shell">
    <header id="wb-header">
      <h1>aiui <span>workbench</span></h1>
      <span class="wb-tagline">full pipeline · no agent · trace everything</span>
      <select id="wb-app-pick" title="scenery app"></select>
      <span id="wb-status" class="wb-chip">starting servers…</span>
    </header>
    <div id="wb-split">
      <div id="wb-app"></div>
      <div id="wb-dock">
        <div id="wb-pane-host"></div>
      </div>
    </div>
  </div>`;

function must<T extends Element>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (!el) {
    throw new Error(`workbench shell failed to render (${selector})`);
  }
  return el;
}
const appHost = must<HTMLDivElement>("#wb-app");
const appPick = must<HTMLSelectElement>("#wb-app-pick");
const status = must<HTMLSpanElement>("#wb-status");
const paneHost = must<HTMLDivElement>("#wb-pane-host");

for (const app of WORKBENCH_APPS) {
  const option = document.createElement("option");
  option.value = app.id;
  option.textContent = app.label;
  appPick.append(option);
}
appPick.value = localStorage.getItem(APP_STORAGE_KEY) ?? WORKBENCH_APPS[0].id;
if (!WORKBENCH_APPS.some((app) => app.id === appPick.value)) {
  appPick.value = WORKBENCH_APPS[0].id;
}

// ── the app slot (left pane) ─────────────────────────────────────────────────
const appCtx: WorkbenchAppContext = {};
let cleanupApp: (() => void) | undefined;
let channelPort: number | undefined;

function mountSelectedApp(): void {
  const app: WorkbenchApp = WORKBENCH_APPS.find((a) => a.id === appPick.value) ?? WORKBENCH_APPS[0];
  localStorage.setItem(APP_STORAGE_KEY, app.id);
  cleanupApp?.();
  cleanupApp = app.mount(appHost, appCtx);
  // Inline apps get the workbench page's own overlay; iframe apps bring their
  // own (their dev server points at the same debug channel) — mounting both
  // would put two armed keymaps on one screen.
  if (app.overlay === "workbench" && channelPort !== undefined) {
    mountIntentTool({ force: true, port: channelPort });
  } else {
    unmountIntentTool();
  }
}
appPick.addEventListener("change", mountSelectedApp);
mountSelectedApp(); // scenery renders immediately; the overlay follows the port

// ── the dock (right pane) ────────────────────────────────────────────────────
// One pane: the shared TraceView, live-following the newest turn. The tab bar is
// gone (like the intent tool with a single modality) — the trace view is now the
// whole debugging surface, subsuming the old Raw-frames and Prompt tabs.
function buildDock(baseUrl: string): void {
  const pane = new TracesPane({ baseUrl });
  paneHost.replaceChildren(pane.root);
  pane.activate();
}

// ── server discovery ─────────────────────────────────────────────────────────
async function waitForServers(): Promise<void> {
  for (;;) {
    try {
      const res = await fetch("/wb/api/servers");
      const servers = (await res.json()) as {
        channel?: { port: number; record: boolean };
        demo?: { url: string };
        error?: string;
      };
      if (servers.demo) {
        appCtx.demoUrl = servers.demo.url;
      }
      if (servers.channel) {
        channelPort = servers.channel.port;
        status.textContent = `channel :${channelPort} · debug${servers.channel.record ? " · REC" : ""}`;
        status.classList.add("ok");
        buildDock(`http://127.0.0.1:${channelPort}`);
        mountSelectedApp(); // now that the port is known, the overlay can mount
        return;
      }
      if (servers.error) {
        status.textContent = servers.error;
        status.classList.add("err");
      }
    } catch {
      // dev server still coming up
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}
void waitForServers();
