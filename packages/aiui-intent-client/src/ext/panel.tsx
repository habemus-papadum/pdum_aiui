/**
 * panel.tsx — the MV3 side panel: the SAME client, in an extension window.
 *
 * This file is the whole shell. Everything that makes the panel a panel — the
 * machine, the claims, the bar, the pills, the keys, the lanes, the wire — is
 * imported unchanged from the client the plain page uses. What differs is two
 * lines of composition: the host is an `ExtensionBus` instead of a `CdpBus`,
 * and the channel is discovered instead of inherited from the page's origin.
 *
 * That is the architecture paying out. The extension was built LAST, on purpose:
 * it is a shell around the client, not the place the client lives.
 *
 * The activation gesture arrives from the service worker (the command chord and
 * the toolbar click are extension invocations — they are what grant `tabCapture`
 * on a tab), so this panel does not listen for ⌘B itself; it listens for the
 * worker's message and crosses the imperative boundary exactly as the page does.
 */

import { WorkletPcmSource } from "@habemus-papadum/aiui-dev-overlay/multimodal-talk";
import { render } from "@solidjs/web";
import { createSignal } from "solid-js";
import { activationGesture } from "../activation";
import { createBarHost } from "../bar-host";
import { createIntentClient, type IntentClient, type IntentLanes } from "../client";
import { installConfigAutoSave, loadConfigBase } from "../config-store";
import { type ChannelLanes, createChannelLanes } from "../lanes";
import { createPencilHost } from "../pencil-host";
import { connectSessionBus, probeChannel } from "../session";
import { createToolsLink } from "../tools-link";
import { PanelLayout } from "../ui/panel-layout";
import { installPanelKeys, type Narration } from "../ui/shell";
import { heldStreamFor } from "./capture";
import {
  discoverChannel,
  listChannels,
  onCdpTagChanged,
  readCdpTag,
  rememberPort,
} from "./channel";
import { connectExtensionBus } from "./extension-bus";
import { type ActivateMessage, BROKER_ADDRESS, isActivateMessage } from "./protocol";
import { relayRequest } from "./relay";
import { SidePanelZoom } from "./side-panel-zoom";

const [statusLine, setStatusLine] = createSignal("", { ownedWrite: true });
const [toastLine, setToastLine] = createSignal<string | undefined>(undefined, { ownedWrite: true });
const [loweredPrompt, setLoweredPrompt] = createSignal<string | undefined>(undefined, {
  ownedWrite: true,
});
let toastTimer: ReturnType<typeof setTimeout> | undefined;
/** The bus phase, for the channel header's dot (written by onChange in boot). */
const [busPhase, setBusPhase] = createSignal<"connected" | "connecting" | "closed">("closed", {
  ownedWrite: true,
});
const narration: Narration = {
  statusLine,
  setStatusLine,
  toastLine,
  loweredPrompt,
  setLoweredPrompt,
  toast: (message) => {
    setToastLine(message);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => setToastLine(undefined), 4000);
  },
};

loadConfigBase();
installConfigAutoSave(); // every change persists — no save/reset verbs (owner)

/** Lanes that only narrate — the panel is fully usable with no channel found. */
const consoleLanes: IntentLanes = {
  openTurn: () => console.info("[lanes] openTurn"),
  sendTurn: () => console.info("[lanes] sendTurn"),
  cancelTurn: () => console.info("[lanes] cancelTurn"),
  takeShot: (tab) => console.info("[lanes] takeShot", tab),
  addSelection: (tab) => console.info("[lanes] addSelection", tab),
  clearInk: (tab) => console.info("[lanes] clearInk", tab),
  clearPencil: (tab) => console.info("[lanes] clearPencil", tab),
  startTalk: (mode) => console.info("[lanes] startTalk", mode),
  stopTalk: () => console.info("[lanes] stopTalk"),
  setMicMuted: (muted) => console.info("[lanes] setMicMuted", muted),
};

async function boot(): Promise<{
  client: IntentClient;
  lanes?: ChannelLanes;
  windowId: number;
  /** The discovered channel - also where the lowering traces live. */
  port?: number;
}> {
  const { id: windowId } = await chrome.windows.getCurrent();
  if (windowId === undefined) {
    throw new Error("the side panel has no window — cannot target tabs");
  }
  const host = await connectExtensionBus({
    windowId,
    log: (message) => console.info("[ext]", message),
  });

  const port = await discoverChannel();
  const health = port !== undefined ? await probeChannel(port) : undefined;
  if (port === undefined || health === undefined) {
    setStatusLine("no channel found — run `aiui claude`, then reopen this panel");
    const client = createIntentClient({
      host,
      lanes: consoleLanes,
      onBlip: (key) => blipSink?.(key),
    });
    (window as unknown as { __aiuiIntentClient?: unknown }).__aiuiIntentClient = { client, host };
    return { client, windowId };
  }
  await rememberPort(port);

  const lanes = createChannelLanes({
    host,
    port: () => port,
    // The mic worklet ships as a FILE here. An extension page's CSP is
    // `script-src 'self'`, which rejects the blob: worklet module the plain
    // page loads happily ("AbortError: Unable to load a worklet's module" —
    // measured by the old client, 2026-07-13). The build emits the module from
    // the same constant the source uses, so the two cannot drift.
    pcmSource: () => new WorkletPcmSource({ workletUrl: chrome.runtime.getURL("pcm-worklet.js") }),
    tabMeta: async () => {
      const tab = host.activeTab();
      const info = tab !== undefined ? await host.targeting.tabInfo?.(tab) : undefined;
      return { url: info?.url ?? "", title: info?.title ?? "", kind: "side-panel" };
    },
    onStatus: (line) => {
      setStatusLine(line);
      console.info("[intent-client]", line);
    },
    onToast: narration.toast,
    onLoweredPrompt: (prompt) => setLoweredPrompt(prompt),
  });
  const client = createIntentClient({
    host,
    lanes: lanes.lanes,
    claimOptions: lanes.claimOptions,
    onBlip: (key) => blipSink?.(key),
  });
  lanes.bind(client);

  // The page-tools bridge — real chrome tab/window identity in this tier.
  createToolsLink({ host, port: () => port, windowId, log: (m) => console.info("[tools]", m) });

  // The remote pencil: an iPad marks up the tab, its strokes landing on the
  // in-page surface. The video is the SAME warm tabCapture MediaStream the shot
  // grabs off (heldStreamFor) — shared, not a second capture — so it appears
  // exactly when a turn warms the stream. Strokes forward to the tab in view.
  createPencilHost({
    host,
    port,
    tab: () => host.activeTab(),
    stream: () => heldStreamFor(host.activeTab()),
    streamHint: () => "grant this tab with ⌘B to start its video",
    label: `aiui intent — window ${windowId}`,
  }).connect();

  // The remote bar: the same mode engine's remote-flagged caps (hands-free,
  // video), projected over /bar for the iPad pencil client's embedded RemoteBar.
  createBarHost({ client, port, label: `aiui intent — window ${windowId}` }).connect();
  const sessionBus = connectSessionBus({ port, label: "intent client (side panel)" });
  let recovered = false;
  sessionBus.onChange((state) => {
    setBusPhase(state.phase);
    client.setContext({ connected: state.phase === "connected" });
    // See main.tsx: recovery waits for the channel, because re-arming is gated
    // on having one.
    if (!recovered && state.phase === "connected") {
      recovered = true;
      if (lanes.recover(client)) {
        setStatusLine("turn recovered from the mirror — re-grant with ⌘B");
      }
    }
  });

  (window as unknown as { __aiuiIntentClient?: unknown }).__aiuiIntentClient = {
    client,
    host,
    lanes,
    sessionBus,
  };
  setStatusLine(`channel :${port} — driving this window's tabs`);
  return { client, lanes, windowId, port };
}

let blipSink: ((key: string) => void) | undefined;

const { client, lanes, windowId, port } = await boot();

/**
 * The CDP tag's verdict, for the debugging pane: the tag arrives through this
 * browser's own debug endpoint (src/cdp/tagger.ts), so its presence PROVES
 * which channel drives this browser — and a mismatch with the bound port is
 * exactly the cross-browser confusion the tagger exists to expose.
 */
const [cdpVerdict, setCdpVerdict] = createSignal("CDP: no tag — no channel drives this browser", {
  ownedWrite: true,
});
const applyTagVerdict = (tag: Awaited<ReturnType<typeof readCdpTag>>): void => {
  if (tag === undefined) {
    return;
  }
  setCdpVerdict(
    tag.port === port
      ? `CDP: this browser ✓ (:${tag.port}, via ${tag.browserUrl})`
      : `CDP: this browser is driven by :${tag.port} (panel bound to :${port ?? "none"})`,
  );
};
void readCdpTag().then(applyTagVerdict);
onCdpTagChanged(applyTagVerdict); // the tagger may land after boot — track it

/**
 * The activation gesture, arriving from OUTSIDE (the worker). The toolbar click
 * and the command chord are extension invocations — they are what grant
 * `tabCapture` standing on a tab — so the worker is where they land, and this is
 * the imperative → Solid boundary crossing (activation.ts is the reference).
 */
const activate = (tabId: number | undefined): void => {
  activationGesture(client, tabId ?? client.context().activeTab);
};
chrome.runtime.onMessage.addListener((msg: unknown) => {
  if (isActivateMessage(msg) && msg.windowId === windowId) {
    activate(msg.tabId);
  }
  return false;
});
// A panel OPENED by the activation missed the broadcast (it was still booting):
// the worker parks the press, and we pull it here.
void relayRequest<ActivateMessage | null>(BROKER_ADDRESS, "pendingActivation", { windowId })
  .then((parked) => {
    if (parked !== null && isActivateMessage(parked)) {
      activate(parked.tabId);
    }
  })
  .catch(() => {});

installPanelKeys({ client });

const root = document.getElementById("root");
if (root === null) {
  throw new Error("intent side panel: #root missing");
}
render(
  () => (
    <>
      {/* The side panel's own zoom (owner, 2026-07-16): a fixed top-right cluster,
          the plain page has none. It floats over the layout, so it sits here as a
          sibling rather than threading through PanelLayout. */}
      <SidePanelZoom />
      <PanelLayout
        port={port}
        phase={busPhase}
        // Native host FIRST (the extension's one NM use), mirror fallback.
        listChannels={() => listChannels(port)}
        onSwitch={(next) => {
          // The extension's rebind: remember the port (discovery tries recent
          // ports first), then reboot the panel document onto it.
          void rememberPort(next).then(() => location.reload());
        }}
        client={client}
        registerBlipSink={(sink) => (blipSink = sink)}
        micLevel={lanes !== undefined ? () => lanes.talk.level() : undefined}
        lanes={lanes}
        narration={narration}
        // The extension drives its own tab; there is no separate CDP target to name.
        debug={{
          content: (
            <div style="font: 11px ui-monospace, monospace; opacity: 0.8; padding: 2px 0 4px">
              {cdpVerdict()}
            </div>
          ),
        }}
      />
    </>
  ),
  root,
);
