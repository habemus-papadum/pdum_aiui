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
 * The dock's trace views are the shared debug-ui — the same components the
 * DevTools extension embeds — so improving them improves every host at once.
 */
import { mountIntentTool, unmountIntentTool } from "@habemus-papadum/aiui-dev-overlay";
import { WORKBENCH_APPS, type WorkbenchApp, type WorkbenchAppContext } from "./apps";
import { FramesFeed } from "./frames-feed";
import { PromptPane } from "./prompt-pane";
import { RawPane } from "./raw-pane";
import { STYLES } from "./styles";
import { TracesPane } from "./traces-pane";

const APP_STORAGE_KEY = "aiui-workbench-app";

interface Pane {
  root: HTMLElement;
  activate(): void;
  deactivate(): void;
}

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
        <nav id="wb-tabs"></nav>
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
const tabsNav = must<HTMLElement>("#wb-tabs");
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
function buildDock(baseUrl: string): void {
  const feed = new FramesFeed({ baseUrl });
  const panes: Record<string, Pane> = {
    traces: new TracesPane({ baseUrl }),
    raw: new RawPane(feed),
    prompt: new PromptPane(feed),
  };
  let active: Pane | undefined;
  const buttons = new Map<string, HTMLButtonElement>();
  const show = (id: string): void => {
    active?.deactivate();
    paneHost.replaceChildren();
    const pane = panes[id];
    paneHost.append(pane.root);
    pane.activate();
    active = pane;
    for (const [key, button] of buttons) {
      button.classList.toggle("selected", key === id);
    }
  };
  for (const [id, label] of [
    ["traces", "Trace"],
    ["raw", "Raw frames"],
    ["prompt", "Prompt"],
  ] as const) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.addEventListener("click", () => show(id));
    buttons.set(id, button);
    tabsNav.append(button);
  }
  show("traces");
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
