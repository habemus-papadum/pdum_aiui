/**
 * Service worker: plumbing only, no precious state (MV3 kills and restarts it
 * freely — measured in the spikes: an in-memory invocation ledger died while
 * Chrome's activeTab grants survived, so this map is a debugging aid, not the
 * source of truth).
 *
 * The action click is the load-bearing gesture: it grants activeTab on the
 * clicked tab (later steps hang tabCapture on that) and opens this window's
 * side panel.
 */
import { serveRelay } from "@habemus-papadum/aiui-webext";

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

serveRelay("sw", {
  /** Invocations seen by this worker instance (per-lifetime, see module doc). */
  invocations: () => Object.fromEntries(invocations),
  /** Liveness probe for the panel's Dev pane. */
  ping: () => ({ at: new Date().toISOString() }),
});
