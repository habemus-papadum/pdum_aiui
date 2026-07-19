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

import { WorkletPcmSource } from "@habemus-papadum/aiui-intent-runtime/talk";
import { render } from "@solidjs/web";
import { createSignal } from "solid-js";
import { activationGesture } from "../activation";
import { createBarHost } from "../bar-host";
import { createIntentClient, type IntentClient, type IntentLanes } from "../client";
import { installConfigAutoSave, loadConfigBase } from "../config-store";
import { type ChannelLanes, createChannelLanes } from "../lanes";
import { createPencilHost } from "../pencil-host";
import {
  asContributedSelection,
  connectSessionBus,
  probeChannel,
  type SessionBusClient,
} from "../session";
import { createToolsLink } from "../tools-link";
import { PanelLayout } from "../ui/panel-layout";
import { installPanelKeys, type Narration } from "../ui/shell";
import { TargetTab } from "../ui/target-tab";
import { heldStreamFor } from "./capture";
import {
  discoverChannel,
  listChannels,
  onCdpTagChanged,
  pinPort,
  readCdpTag,
  rememberPort,
} from "./channel";
import { connectExtensionBus } from "./extension-bus";
import { superviseMicGrant } from "./mic-grant";
import { type ActivateMessage, BROKER_ADDRESS, isActivateMessage } from "./protocol";
import { relayRequest } from "./relay";
import { SidePanelZoom } from "./side-panel-zoom";

const [statusLine, setStatusLine] = createSignal("", { ownedWrite: true });
const [toastLine, setToastLine] = createSignal<string | undefined>(undefined, { ownedWrite: true });
let toastTimer: ReturnType<typeof setTimeout> | undefined;
/** The bus phase, for the channel header's dot (written by onChange in boot). */
const [busPhase, setBusPhase] = createSignal<"connected" | "connecting" | "closed">("closed", {
  ownedWrite: true,
});
const narration: Narration = {
  statusLine,
  setStatusLine,
  toastLine,
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
  /** The bus, for the render tree (the target-tab chip reads its targeting). */
  host: Awaited<ReturnType<typeof connectExtensionBus>>;
}> {
  const { id: windowId } = await chrome.windows.getCurrent();
  if (windowId === undefined) {
    throw new Error("the side panel has no window — cannot target tabs");
  }
  const host = await connectExtensionBus({
    windowId,
    log: (message) => console.info("[ext]", message),
  });

  // The activation gesture AS BOUND, for every human-facing hint — the bus
  // reads it live from chrome.commands (users rebind; Chrome silently drops a
  // claimed suggestion), so no chord name is ever hard-coded here.
  const hint = host.capture.grantHint ?? "the aiui toolbar button";

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
    return { client, windowId, host };
  }
  await rememberPort(port);

  const lanes = createChannelLanes({
    host,
    port: () => port,
    // The mic worklet ships as a FILE here. An extension page's CSP is
    // `script-src 'self'`, which rejects the blob: worklet module the plain
    // page loads happily ("AbortError: Unable to load a worklet's module" —
    // measured in the retired extension client). The build emits the module from
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
  });
  // Assigned below; the dispatch hook closes over it (dispatches can only
  // happen after boot completes, by which time the bus is dialing).
  let sessionBus: SessionBusClient | undefined;
  const client = createIntentClient({
    host,
    lanes: lanes.lanes,
    claimOptions: lanes.claimOptions,
    onBlip: (key) => blipSink?.(key),
    // Mirror armed-ness into the bus's cached `armed` slot: the hub echoes it
    // on /session/peers and /session/publish so an external sender (the
    // VS Code extension) can phrase its confirmation honestly.
    onDispatch: (event) => {
      const armed = event.after.phase !== "disarmed";
      if (armed !== (event.before.phase !== "disarmed")) {
        sessionBus?.set("armed", armed);
      }
    },
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
    streamHint: () => `grant this tab with ${hint} to start its video`,
    label: `aiui intent — window ${windowId}`,
    // The 'ipad' status pill: connected remote pencil clients, live from the
    // relay session's status feed.
    onStatus: (status) => client.setContext({ pencilClients: status.viewers }),
  }).connect();

  // The remote bar: the same mode engine's remote-flagged caps (hands-free,
  // video), projected over /bar for the iPad pencil client's embedded RemoteBar.
  createBarHost({ client, port, label: `aiui intent — window ${windowId}` }).connect();
  sessionBus = connectSessionBus({ port, label: "intent client (side panel)" });
  const bus2 = sessionBus;
  let recovered = false;
  sessionBus.onChange((state) => {
    setBusPhase(state.phase);
    client.setContext({ connected: state.phase === "connected" });
    if (state.phase === "connected") {
      // (Re)sync the cached `armed` slot — a reconnect gets fresh truth.
      bus2.set("armed", client.state().phase !== "disarmed");
    }
    // See main.tsx: recovery waits for the channel, because re-arming is gated
    // on having one.
    if (!recovered && state.phase === "connected") {
      recovered = true;
      if (lanes.recover(client)) {
        setStatusLine(`turn recovered from the mirror — re-grant with ${hint}`);
      }
    }
  });
  // Editor-contributed selections (the VS Code extension's "Send Selection to
  // Browser Tab", relayed by the hub): straight into the wire engine as a
  // code-selection event — armed-gated by the engine's own lifecycle, and the
  // gate's verdict is toasted so a drop is never silent.
  sessionBus.onPublish((msg) => {
    const sel = asContributedSelection(msg);
    if (sel === undefined) {
      return;
    }
    const marker = lanes.engine.codeSelection(sel);
    narration.toast(
      marker !== undefined
        ? `selection from the editor added to the turn (${sel.sourceLoc ?? marker})`
        : `selection from the editor ignored — arm the client first (${hint})`,
    );
  });

  (window as unknown as { __aiuiIntentClient?: unknown }).__aiuiIntentClient = {
    client,
    host,
    lanes,
    sessionBus,
  };
  // No baseline status here (owner, 2026-07-19): the channel header already
  // shows the port and the connection dot, so the status line stays EMPTY
  // until something worth saying happens (shell.tsx's Narration contract).
  console.info(
    "[intent-client]",
    `channel :${port} — this panel targets window ${windowId}'s tabs`,
  );
  return { client, lanes, windowId, port, host };
}

let blipSink: ((key: string) => void) | undefined;

const { client, lanes, windowId, port, host } = await boot();

// The microphone, probed at every panel open (M9's deferred grant flow — see
// mic-grant.ts). Silent where the mic works (flagged session browser; stock
// Chrome after the one-time dance); where it doesn't, the status line says so
// and the grant page auto-opens. Feeds the mic pill its first real supplier.
void superviseMicGrant({
  setGranted: (granted) => client.setContext({ micGranted: granted }),
  onBlocked: (message) => {
    setStatusLine(message);
    narration.toast(message);
  },
});

/**
 * The CDP tag's verdict: the tag arrives through this browser's own debug
 * endpoint (src/cdp/tagger.ts), so its presence PROVES which channel drives
 * this browser. Console-only now (owner, 2026-07-19) — "no tag" is the
 * PERMANENT normal state in an everyday Chrome (it is not the session
 * browser), so a visible line read like an error. The one verdict worth
 * surfacing is a MISMATCH — proof another channel drives this browser than
 * the one the panel is bound to — and that goes to the red toast.
 */
const applyTagVerdict = (tag: Awaited<ReturnType<typeof readCdpTag>>): void => {
  if (tag === undefined) {
    console.info(
      "[cdp]",
      "no tag — no channel drives this browser over CDP (normal outside the session browser)",
    );
    return;
  }
  if (tag.port === port) {
    console.info(
      "[cdp]",
      `this browser ✓ — driven by the bound channel :${tag.port} (via ${tag.browserUrl})`,
    );
    return;
  }
  const message = `this browser is driven by channel :${tag.port}, but the panel is bound to :${port ?? "none"}`;
  console.warn("[cdp]", message);
  narration.toast(`CDP mismatch: ${message}`);
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
          sibling rather than threading through PanelLayout. It zooms `#root` (the
          panel content), NOT the document — so the turn preview's body-attached
          hover peek escapes the zoom and stays in viewport space. */}
      <SidePanelZoom target={root} />
      <PanelLayout
        port={port}
        phase={busPhase}
        // Native host FIRST (the extension's one NM use), mirror fallback.
        listChannels={() => listChannels(port)}
        onSwitch={(next) => {
          // The extension's rebind: PIN the pick (an explicit choice outranks
          // the discovery ladder — CDP tag included — until it dies or the
          // user picks again), then reboot the panel document onto it.
          void pinPort(next).then(() => location.reload());
        }}
        client={client}
        registerBlipSink={(sink) => (blipSink = sink)}
        micLevel={lanes !== undefined ? () => lanes.talk.level() : undefined}
        lanes={lanes}
        narration={narration}
        // Which tab this panel is aimed at (reintroduced for this tier, owner
        // 2026-07-19): the extension drives its own window's ACTIVE tab, and
        // naming it here confirms the plumbing (targeting + navigation
        // events) is live. Same chip as the standalone panel — pure display
        // over the SurfaceTargeting seam, refreshed by the transport's
        // navigation events.
        targetTab={
          <TargetTab
            targeting={host.targeting}
            onPageEvent={(h) => host.transport.onPageEvent(h)}
          />
        }
        // No debug pane in this tier (the CDP verdict lives in the console;
        // a mismatch toasts).
      />
    </>
  ),
  root,
);
