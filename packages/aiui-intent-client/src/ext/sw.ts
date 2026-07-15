/**
 * sw.ts — the service worker: the broker. Plumbing only, no precious state
 * (MV3 kills and restarts it freely — the old extension measured exactly that:
 * an in-memory ledger died while Chrome's own grants survived). Salvaged from
 * `aiui-extension/src/sw.ts`, which earned every line of its comments.
 *
 * It does the three things only it can do:
 *
 *  1. **Mint the capture grant.** `tabCapture.getMediaStreamId` is privileged
 *     and invocation-gated — the panel cannot call it, and it works only on a
 *     tab the user invoked the extension on. The toolbar click and the command
 *     chord ARE those invocations, which is why activation is what makes shots
 *     possible: the gesture is the grant (BEHAVIOR.md).
 *  2. **Carry the activation.** A `chrome.commands` press lands here, not in
 *     the panel; the worker opens the side panel (synchronously — the gesture
 *     token does not survive an `await`, verified live in the old client) and
 *     tells the panel which tab was granted.
 *  3. **Watch navigations.** `chrome.webNavigation` sees SPA route changes that
 *     an isolated-world content script structurally cannot (the page's
 *     `history` lives in the page's realm).
 *
 * Plus the reload chore: an extension reload ORPHANS the content scripts in
 * already-open tabs — their runtime context dies and only a navigation would
 * re-inject — which silently kills the ring, the ink, and the key layer in
 * every open tab. In development, reloads are constant. So: re-inject.
 */

import {
  ACTIVATE_COMMAND,
  type ActivateMessage,
  type NavigationMessage,
  type StreamIdResult,
} from "./protocol";
import { serveRelay } from "./relay";

/** tabId → the last URL we saw, so a navigation can name both sides. */
const lastUrl = new Map<number, string>();

/** Re-inject after an extension (re)load — see the module doc. Both worlds:
 * the manifest declares an ISOLATED script and a MAIN one, and `executeScript`
 * must be told which is which (`world` predates @types/chrome's manifest type,
 * hence the cast). */
const reinjectContentScripts = async (): Promise<void> => {
  const scripts = (chrome.runtime.getManifest().content_scripts ?? []) as Array<{
    js?: string[];
    world?: "MAIN" | "ISOLATED";
  }>;
  const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
  await Promise.allSettled(
    tabs.flatMap((tab) =>
      tab.id === undefined
        ? []
        : scripts.map((script) =>
            chrome.scripting.executeScript({
              target: { tabId: tab.id as number },
              files: script.js ?? [],
              world: script.world === "MAIN" ? "MAIN" : "ISOLATED",
            }),
          ),
    ),
  );
};
chrome.runtime.onInstalled.addListener(() => void reinjectContentScripts());

/** The invocation: grant this tab, open the panel, tell the panel. */
const invoke = (windowId: number | undefined, tabId: number | undefined): void => {
  if (windowId === undefined) {
    return;
  }
  // MUST be synchronous in the listener: the user-gesture token does not
  // survive an await (the old client verified this the hard way — a
  // `getContexts` check before `open()` made the chord a silent no-op with the
  // panel closed).
  void chrome.sidePanel.open({ windowId }).catch(() => {});
  const message: ActivateMessage = {
    aiuiIntentActivate: 1,
    windowId,
    ...(tabId !== undefined ? { tabId } : {}),
    at: Date.now(),
  };
  // Fire-and-forget: a panel that is still booting misses this and asks for it
  // instead (the `pendingActivation` command below).
  chrome.runtime.sendMessage(message).catch(() => {});
  if (windowId !== undefined) {
    pending.set(windowId, message);
  }
};

/** windowId → the most recent unconsumed activation (a boot hand-off, never
 * truth: the worker may die at any moment, and Chrome's real grant outlives it). */
const pending = new Map<number, ActivateMessage>();

chrome.action.onClicked.addListener((tab) => invoke(tab.windowId, tab.id));
chrome.commands.onCommand.addListener((command, tab) => {
  if (command === ACTIVATE_COMMAND) {
    invoke(tab?.windowId, tab?.id);
  }
});

// ── navigations: the browser's own answer (see the module doc) ───────────────
const reportNavigation = (
  tabId: number,
  to: string,
  navKind: NavigationMessage["navKind"],
): void => {
  const from = lastUrl.get(tabId);
  lastUrl.set(tabId, to);
  if (from === undefined || from === to) {
    return; // the first sighting of a tab is not a navigation
  }
  const message: NavigationMessage = { aiuiIntentNavigation: 1, tabId, from, to, navKind };
  chrome.runtime.sendMessage(message).catch(() => {});
};

chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
  if (details.frameId === 0) {
    reportNavigation(details.tabId, details.url, "push");
  }
});
chrome.webNavigation.onReferenceFragmentUpdated.addListener((details) => {
  if (details.frameId === 0) {
    reportNavigation(details.tabId, details.url, "hash");
  }
});
chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId !== 0) {
    return;
  }
  const kind = details.transitionType === "reload" ? "reload" : "push";
  reportNavigation(details.tabId, details.url, kind);
});
chrome.tabs.onRemoved.addListener((tabId) => lastUrl.delete(tabId));

/** Promisified `getMediaStreamId` (callback-style in @types/chrome). The
 * invocation-gate failure arrives via `runtime.lastError` — rethrown so the
 * panel can recognize it and name the remedy. */
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

serveRelay("intent-sw", {
  /** Mint a tabCapture stream id for `tabId` — the PANEL consumes it (M10). A
   * fresh id expires within seconds if unconsumed, so the panel asks only when
   * it is about to hold the stream. */
  streamId: async (payload): Promise<StreamIdResult> => {
    const { tabId } = payload as { tabId: number };
    return { streamId: await getMediaStreamId(tabId) };
  },
  /** The boot hand-off: a panel opened BY an activation missed the broadcast. */
  pendingActivation: (payload) => {
    const { windowId } = payload as { windowId: number };
    const activation = pending.get(windowId) ?? null;
    pending.delete(windowId);
    return activation;
  },
  /** Liveness probe. */
  ping: () => ({ at: new Date().toISOString() }),
});
