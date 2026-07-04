/**
 * Background service worker: stamps tab identity onto dev pages.
 *
 * Only the extension layer can know a page's tab identity — the page itself
 * has no API for it. Whenever a tab on a dev host (see manifest
 * host_permissions) finishes loading, this worker assembles the tab's stamp —
 * its `chrome.tabs` ids plus (via `chrome.debugger.getTargets()`, which does
 * NOT attach and so disturbs no other debugger client) the tab's CDP
 * page-target id — and injects a one-liner that writes it to `data-aiui-tab`
 * on `<html>`. The aiui intent tool reads the attribute at send time and
 * ships the ids in its hello envelope.
 *
 * Injection from here (chrome.scripting) rather than a manifest content
 * script: the worker already knows the tabId, so there is no message round
 * trip — and no classic-script emit problem (this package compiles as ES
 * modules, which content scripts can't be).
 *
 * The stamp is correlation data for an agent driving the Chrome DevTools MCP —
 * see tab-info.ts for why none of these ids is the MCP's own pageId.
 */
import { buildTabStamp, type DebugTargetLike, type TabStamp } from "./tab-info.js";

/** The dev hosts worth stamping — keep in sync with manifest host_permissions. */
const DEV_PAGE = /^http:\/\/(localhost|127\.0\.0\.1)([:/]|$)/;

/** Runs inside the page (isolated world; the DOM is shared with the page). */
function applyStamp(stamp: TabStamp): void {
  document.documentElement.dataset.aiuiTab = JSON.stringify(stamp);
}

/** Callback-style getTargets: promise overloads are newer than our browsers. */
function getTargets(): Promise<DebugTargetLike[]> {
  return new Promise((resolve) => {
    try {
      chrome.debugger.getTargets((targets) => {
        // Touch lastError so a failed call is not logged as unchecked.
        void chrome.runtime.lastError;
        resolve(targets ?? []);
      });
    } catch {
      resolve([]);
    }
  });
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete" || !tab.url || !DEV_PAGE.test(tab.url)) {
    return;
  }
  void getTargets().then((targets) => {
    const stamp = buildTabStamp(
      {
        id: tabId,
        ...(tab.windowId !== undefined ? { windowId: tab.windowId } : {}),
        ...(tab.index !== undefined ? { index: tab.index } : {}),
      },
      targets,
    );
    chrome.scripting
      .executeScript({ target: { tabId }, func: applyStamp, args: [stamp] })
      // A tab that navigated away or closed mid-flight is not an error.
      .catch(() => {});
  });
});
