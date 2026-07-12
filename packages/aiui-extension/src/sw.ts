/**
 * Service worker: plumbing only, no precious state (MV3 kills and restarts it
 * freely — measured in the spikes: an in-memory invocation ledger died while
 * Chrome's activeTab grants survived, so this map is a debugging aid, not the
 * source of truth).
 *
 * The action click is the load-bearing gesture: it grants activeTab on the
 * clicked tab — which is precisely what `tabCapture.getMediaStreamId` hangs
 * picker-free capture on (invocation-gated, per tab, durable across SW
 * restarts until navigation/tab close) — and opens this window's side panel.
 *
 * Capture plumbing (proposal §1: getMediaStreamId + offscreen management live
 * here): the panel asks `sw/capture`, this worker mints a stream id for the
 * target tab and hands it to the offscreen document, which grabs ONE frame
 * and stops the stream (one-stream-per-tab economy). The worker holds nothing.
 */
import { ensureOffscreenDocument, relayRequest, serveRelay } from "@habemus-papadum/aiui-webext";
import type { CaptureRequest, ShotGrab } from "./capture";
import type { PendingLeader } from "./panel/leader";

/** The static capture room under public/ — see that file for why it's static. */
const OFFSCREEN_URL = "offscreen.html";

/** tabId → ISO time of the last action click in THIS worker's lifetime. */
const invocations = new Map<number, string>();

chrome.action.onClicked.addListener((tab) => {
  if (tab.id !== undefined) {
    invocations.set(tab.id, new Date().toISOString());
  }
  if (tab.windowId !== undefined) {
    void chrome.sidePanel.open({ windowId: tab.windowId });
  }
});

// ── the leader (proposal §13.5) ──────────────────────────────────────────────
// The global shortcut is an extension INVOCATION (like the action click above,
// it grants the tab activeTab/tabCapture standing — the invocation-gate
// softener), so it lands in the same ledger. The panel is the layer's brain;
// this worker only makes sure one exists for the window and tells it. A panel
// that is still booting misses the broadcast, so the press is also parked in
// `pendingLeaders` for the boot-time pull (relay `leaderPending` below; the
// panel applies the freshness rule — leader.ts owns the TTL).

/** windowId → the most recent unconsumed leader press (worker-lifetime, like
 * the invocation ledger: a debugging aid and boot hand-off, never truth). */
const pendingLeaders = new Map<number, PendingLeader>();

chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== "aiui-leader") {
    return;
  }
  const windowId = tab?.windowId;
  if (tab?.id !== undefined) {
    invocations.set(tab.id, new Date().toISOString());
  }
  if (windowId === undefined) {
    return;
  }
  pendingLeaders.set(windowId, {
    ...(tab?.id !== undefined ? { tabId: tab.id } : {}),
    at: Date.now(),
  });
  // open() MUST be synchronous in this listener: the command press's
  // user-gesture token does not survive an await (verified live — a
  // getContexts check before open() made ⌘B with the panel closed a silent
  // no-op). Unconditional: on an already-open panel it is a cheap no-op-ish
  // call, and the broadcast below is what actually toggles the layer.
  void chrome.sidePanel.open({ windowId }).catch(() => {});
  // Fire-and-forget, like the armed broadcast: every panel hears it and
  // filters by windowId; a panel still booting pulls `leaderPending` instead.
  chrome.runtime
    .sendMessage({ aiuiLeader: 1, windowId, tabId: tab?.id, at: Date.now() })
    .catch(() => {});
});

/** Promisified `getMediaStreamId` (callback-style in @types/chrome). The
 * invocation-gate failure arrives via `runtime.lastError` — rethrown so the
 * panel can recognize its measured message (capture.ts). */
function getMediaStreamId(targetTabId: number): Promise<string> {
  return new Promise((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId }, (streamId) => {
      const err = chrome.runtime.lastError;
      if (err?.message !== undefined) {
        reject(new Error(err.message));
      } else if (streamId === undefined) {
        reject(new Error("tabCapture returned no stream id"));
      } else {
        resolve(streamId);
      }
    });
  });
}

serveRelay("sw", {
  /**
   * One shot of the given tab: offscreen doc first (a fresh stream id expires
   * within seconds if unconsumed), then the id, then the grab. Returns the
   * offscreen document's {@link ShotGrab} to the panel unchanged.
   */
  capture: async (payload) => {
    const req = payload as CaptureRequest;
    await ensureOffscreenDocument(
      OFFSCREEN_URL,
      ["USER_MEDIA" as chrome.offscreen.Reason],
      "Grab single tab-capture frames for intent-tool shots",
    );
    const streamId = await getMediaStreamId(req.tabId);
    return await relayRequest<ShotGrab>("offscreen", "grab", {
      streamId,
      width: req.width,
      height: req.height,
      dpr: req.dpr,
    });
  },
  /** Invocations seen by this worker instance (per-lifetime, see module doc). */
  invocations: () => Object.fromEntries(invocations),
  /** Consume the window's parked leader press (boot hand-off; see above). */
  leaderPending: (payload) => {
    const { windowId } = payload as { windowId: number };
    const pending = pendingLeaders.get(windowId) ?? null;
    pendingLeaders.delete(windowId);
    return pending;
  },
  /** Liveness probe for the panel's Dev pane. */
  ping: () => ({ at: new Date().toISOString() }),
});
