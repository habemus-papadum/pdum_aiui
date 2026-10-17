/**
 * tab-record.ts — the canonical browser-tab record and its one rendering.
 *
 * `<tab url title aiui-app …/>` is the ONE shape for "which browser tab"
 * everywhere a tab is described to a model — the oracle's `context` slot
 * here, and the same element the agent behind a Claude Code session reads in
 * its lowered prompts (the context preamble, navigation/tab-switch
 * boundaries, selection metadata) — so a model learns one format and
 * recognizes it everywhere, and "this page" means the same thing to every
 * assistant looking at it. The vocabulary is fixed here; the attribute names
 * are the contract the corpus pins.
 *
 * Every field beyond `url` is optional — producers fill what they know, the
 * renderer prints what it gets. The ids live in different namespaces and NONE
 * of them is the Chrome DevTools MCP's own pageId: they are correlation hints;
 * the reliable matching keys are `url` and `title` (via `list_pages`).
 */

/** The canonical tab record — see the module comment. */
export interface TabRecord {
  /** The page's full `location.href` — the primary matching key. */
  url: string;
  /** The page's `document.title`. */
  title?: string;
  /** True when the page carries aiui instrumentation (an aiui app under development). */
  aiui?: boolean;
  /** The dev server's source root, when the page is an instrumented aiui app. */
  sourceRoot?: string;
  /** `chrome.tabs.Tab.id` — extension-layer tab id. */
  chromeTabId?: number;
  /** `chrome.tabs.Tab.windowId`. */
  windowId?: number;
  /** The tab's index in its window (drifts as tabs move; a hint only). */
  tabIndex?: number;
  /** CDP `Target.TargetID`. */
  targetId?: string;
  /** A CDP driver's own handle for this tab, when a driver (not an extension) owns it. */
  driverTab?: number;
}

/**
 * The canonical `<tab>` element — ONE rendering for {@link TabRecord}: full
 * URL first (the agent's `list_pages` matching key), then whatever else the
 * producer knew. The attribute vocabulary is fixed here; every id is a
 * correlation hint, never the DevTools MCP's own pageId.
 */
export function renderTabRecord(tab: TabRecord, indent = ""): string {
  const attrs: string[] = [`url="${escapeXml(tab.url)}"`];
  if (tab.title !== undefined) {
    attrs.push(`title="${escapeXml(tab.title)}"`);
  }
  if (tab.aiui) {
    attrs.push(`aiui-app="true"`);
  }
  if (tab.sourceRoot !== undefined) {
    attrs.push(`source-root="${escapeXml(tab.sourceRoot)}"`);
  }
  if (tab.chromeTabId !== undefined) {
    attrs.push(`chrome-tab-id="${tab.chromeTabId}"`);
  }
  if (tab.windowId !== undefined) {
    attrs.push(`window-id="${tab.windowId}"`);
  }
  if (tab.tabIndex !== undefined) {
    attrs.push(`tab-index="${tab.tabIndex}"`);
  }
  if (tab.targetId !== undefined) {
    attrs.push(`cdp-target-id="${escapeXml(tab.targetId)}"`);
  }
  if (tab.driverTab !== undefined) {
    attrs.push(`driver-tab="${tab.driverTab}"`);
  }
  return `${indent}<tab ${attrs.join(" ")}/>`;
}

/** Escape a value for an XML attribute (the four characters that matter). */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
