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
 * Capture plumbing, as of 2026-07-12 (measured, RESULTS.md M10): this worker
 * mints a `tabCapture` stream id — the one thing only it can do (privileged,
 * invocation-gated) — and hands the ID to the panel, which consumes it with
 * `getUserMedia` and does all the pixel work in its own document. The offscreen
 * capture room is GONE: a side panel can consume a tab stream directly, so the
 * frame never crosses a process boundary and never becomes a base64 string
 * (see src/panel/capture.ts for the latency budget that motivated it).
 */
import { serveRelay } from "@habemus-papadum/aiui-webext";
import type { PendingLeader } from "./panel/leader";

/** tabId → ISO time of the last action click in THIS worker's lifetime. */
const invocations = new Map<number, string>();

// Re-inject the content script after an extension (re)load: reloading ORPHANS
// the copies in already-open tabs — their chrome.runtime context dies and only
// a navigation would re-inject — which silently kills the ring, ink, and key
// relay in every open tab (found live 2026-07-12; in development, reloads are
// constant). The injected file is whatever the built manifest declares, so dev
// (CRXJS loader) and production (bundle) both re-arm. content.ts is written to
// adopt a predecessor's DOM (its HMR posture), so double-injection is safe.
const reinjectContentScripts = async (): Promise<void> => {
  const files = chrome.runtime.getManifest().content_scripts?.[0]?.js ?? [];
  if (files.length === 0) {
    return;
  }
  const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
  await Promise.allSettled(
    tabs
      .filter((tab) => tab.id !== undefined)
      .map((tab) =>
        chrome.scripting.executeScript({
          target: { tabId: tab.id as number },
          files,
        }),
      ),
  );
};
chrome.runtime.onInstalled.addListener(() => void reinjectContentScripts());

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
   * Mint a tabCapture stream id for `tabId` — the panel consumes it (M10). A
   * fresh id expires within seconds if unconsumed, so the panel asks for one
   * only when it is about to hold the stream.
   */
  streamId: async (payload) => {
    const { tabId } = payload as { tabId: number };
    return { streamId: await getMediaStreamId(tabId) };
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
