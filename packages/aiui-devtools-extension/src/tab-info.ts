/**
 * Pure helpers for the tab-identity handoff (see background.ts / content.ts).
 *
 * Kept import-free and side-effect-free so the background worker can load it
 * as a module and the unit tests can exercise the logic without Chrome APIs.
 * Background reading: archive/chrome-devtools-mcp-tab-routing-notes.md — the
 * short version is that Chrome's extension tab id, the CDP target id, and the
 * Chrome DevTools MCP's pageId are three different namespaces, so we ship the
 * first two as correlation hints and let the agent derive the third from
 * `list_pages`.
 */

/** The subset of `chrome.debugger.TargetInfo` the matcher needs. */
export interface DebugTargetLike {
  id: string;
  type: string;
  tabId?: number;
}

/** The identity stamp a page receives (JSON in `data-aiui-tab`). */
export interface TabStamp {
  /** `chrome.tabs.Tab.id` — extension-layer tab id. */
  chromeTabId: number;
  /** `chrome.tabs.Tab.windowId`. */
  windowId?: number;
  /** The tab's index in its window (a drifting hint, not an id). */
  tabIndex?: number;
  /** CDP `Target.TargetID` for the tab's page target, when resolvable. */
  targetId?: string;
}

/** Find the CDP page target belonging to a tab, per `TargetInfo.tabId`. */
export function pageTargetIdFor(targets: DebugTargetLike[], tabId: number): string | undefined {
  return targets.find((t) => t.type === "page" && t.tabId === tabId)?.id;
}

/** Assemble the stamp for a tab (drop undefined fields for a compact JSON). */
export function buildTabStamp(
  tab: { id: number; windowId?: number; index?: number },
  targets: DebugTargetLike[],
): TabStamp {
  const targetId = pageTargetIdFor(targets, tab.id);
  return {
    chromeTabId: tab.id,
    ...(tab.windowId !== undefined ? { windowId: tab.windowId } : {}),
    ...(tab.index !== undefined ? { tabIndex: tab.index } : {}),
    ...(targetId !== undefined ? { targetId } : {}),
  };
}
