/**
 * The workbench: the full intent pipeline with **no agent on the other end**.
 *
 * Layout: the left half hosts the spectra scenery (see scenery.ts — a real-ish
 * app hand-stamped the way the source-locator plugin stamps a real one), the
 * right half is trace instrumentation. The page mounts the *shipping* intent
 * overlay (arm with `` ` ``, talk, ink, shoot, K for tiers — nothing
 * lab-specific), and every turn streams to a **debug channel server this dev
 * server owns** (see vite.config.ts): real transcription, real corrections,
 * real lowering, real traces — but structurally incapable of reaching a Claude
 * session. The final lowered prompt comes back over the websocket instead, so
 * the payoff is *inspection*: watch the raw frames, the trace stages, and the
 * prompt that would have been injected, without ever triggering an agent.
 *
 * The dock is the shared debug-ui {@link TraceView} — the same component the
 * DevTools extension embeds — so improving it improves every host at once. It
 * used to carry three tabs (Trace / Raw frames / Prompt); the trace view now
 * subsumes all three (per-frame wire data lives in the trace stages, and the
 * final prompt is the selected trace's hero), so the dock is a single pane.
 */
import {
  getInstrumentation,
  installPaintHost,
  mountIntentTool,
} from "@habemus-papadum/aiui-dev-overlay";
import { TracesPane } from "@habemus-papadum/aiui-dev-overlay/debug-ui";
import { mountScenery } from "./scenery";
import { STYLES } from "./styles";

// The overlay package's absolute path, define-injected by vite.config.ts. In a
// real app the aiuiDevOverlay Vite plugin seeds `window.__AIUI__.sourceRoot`;
// the workbench runs no plugin, so it seeds the root itself — scenery.ts's
// hand-written `data-source-loc` stamps ("workbench/src/…") are relative to
// the overlay package, and without a root the vscode jump picker's rows have
// no `vscode://file/…` URL to commit (they render grayed).
declare const __WB_SOURCE_ROOT__: string;

const style = document.createElement("style");
style.textContent = STYLES;
document.head.append(style);

// ── the shell ────────────────────────────────────────────────────────────────
document.body.innerHTML = `
  <div id="wb-shell">
    <header id="wb-header">
      <h1>aiui <span>workbench</span></h1>
      <span class="wb-tagline">full pipeline · no agent · trace everything</span>
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
const status = must<HTMLSpanElement>("#wb-status");
const paneHost = must<HTMLDivElement>("#wb-pane-host");

// ── the app slot (left pane) ─────────────────────────────────────────────────
mountScenery(appHost); // scenery renders immediately; the overlay follows the port

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
// Poll until the dev server reports its channel child, then wire the page up.
// The polling loop ONLY discovers (its catch is "dev server still coming up");
// the wiring runs after it resolves, where a mount bug fails loudly on the
// console instead of being swallowed and retried forever.
async function discoverChannelPort(): Promise<number> {
  for (;;) {
    try {
      const res = await fetch("/wb/api/servers");
      const servers = (await res.json()) as {
        channel?: { port: number; record: boolean };
        error?: string;
      };
      if (servers.channel) {
        status.textContent = `channel :${servers.channel.port} · debug${servers.channel.record ? " · REC" : ""}`;
        status.classList.add("ok");
        return servers.channel.port;
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

void discoverChannelPort().then((channelPort) => {
  buildDock(`http://127.0.0.1:${channelPort}`);
  mountIntentTool({ force: true, port: channelPort });
  // The two page-side hookups the aiuiDevOverlay Vite plugin would otherwise
  // own (the workbench mounts manually, so it supplies them itself):
  //  - the source root, for vscode-mode jumps (see the declare above);
  //  - the paint host, so an iPad (or any /paint/ viewer) can see this page
  //    and draw into the intent tool. The channel hosts the paint sidecar via
  //    `aiui claude`'s own auto-detect policy (vite.config.ts), but it binds
  //    loopback — a physical iPad needs a tunnel to reach 127.0.0.1:49223.
  const instrumentation = getInstrumentation();
  if (instrumentation) {
    instrumentation.sourceRoot ??= __WB_SOURCE_ROOT__;
  }
  installPaintHost({ port: channelPort });
});
