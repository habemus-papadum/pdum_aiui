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
  /** Liveness probe for the panel's Dev pane. */
  ping: () => ({ at: new Date().toISOString() }),
});
