/**
 * protocol.ts — the contract between the extension's three worlds: the side
 * PANEL (the client), the service WORKER (the broker), and the CONTENT script
 * (the page). Pure types and constants; nothing here touches `chrome.*`.
 *
 * The load-bearing decision: **the page speaks `PageReport`** — the very same
 * union the CDP tier's injected bootstrap speaks (cdp/page-script.ts). A page
 * fact is a page fact; only its transport differs (a CDP binding there, a
 * `chrome.runtime` message here). So `ExtensionBus` and `CdpBus` map reports to
 * `PageEvent`s with the same vocabulary, and the client core cannot tell which
 * host it is running on. That is the seam doing its job.
 *
 * The capability surface is likewise the same command set the CDP page serves
 * (`ring · flash · keylayer · selection · viewport · ink · locate`) — here it
 * arrives over the relay instead of `Runtime.evaluate`.
 */

import type { PageReport } from "../cdp/page-script";

/** The relay address the content script serves its capabilities under. */
export const PAGE_ADDRESS = "intent-page";
/** The relay address the service worker serves the broker commands under. */
export const BROKER_ADDRESS = "intent-sw";
/** The `chrome.commands` name of the activation gesture. One constant, three
 * readers: the manifest declares it, the worker matches it, and the bus looks
 * up its LIVE binding (`chrome.commands.getAll`) for the hollow ring's hint —
 * which is why no key name is ever hard-coded anywhere. */
export const ACTIVATE_COMMAND = "aiui-intent-activate";

/** A page fact, on its way to the panel (`chrome.runtime.sendMessage`). */
export interface ReportMessage {
  aiuiIntentReport: 1;
  report: PageReport;
}

/** The activation invocation: an action click or the command chord. Carries the
 * tab it granted, which is the whole point — `tabCapture` is invocation-gated,
 * so THIS message is the capture grant becoming a fact (BEHAVIOR.md). */
export interface ActivateMessage {
  aiuiIntentActivate: 1;
  windowId: number;
  tabId?: number;
  at: number;
}

/** A navigation the WORKER saw (`chrome.webNavigation`) — SPA route changes
 * included, which a content script in an isolated world cannot see: `history`
 * is wrapped in the page's realm, not ours. The browser tells us instead. */
export interface NavigationMessage {
  aiuiIntentNavigation: 1;
  tabId: number;
  from: string;
  to: string;
  navKind: "push" | "replace" | "traverse" | "reload" | "hash";
}

export type ExtensionMessage = ReportMessage | ActivateMessage | NavigationMessage;

export function isReportMessage(msg: unknown): msg is ReportMessage {
  return (msg as ReportMessage | null)?.aiuiIntentReport === 1;
}
export function isActivateMessage(msg: unknown): msg is ActivateMessage {
  return (msg as ActivateMessage | null)?.aiuiIntentActivate === 1;
}
export function isNavigationMessage(msg: unknown): msg is NavigationMessage {
  return (msg as NavigationMessage | null)?.aiuiIntentNavigation === 1;
}

/** What the worker's `streamId` command answers (the invocation-gated mint). */
export interface StreamIdResult {
  streamId: string;
}

/**
 * The old extension's on-page ring, as a DOM fact — the coexistence detector.
 *
 * Both clients inject into the same page, and two rings + two ink surfaces on
 * one tab is nonsense. They cannot talk (`chrome.runtime` never crosses
 * extension ids), but they share a DOM: the frozen client's indicator lives at
 * this id, and its shadow root carries an `armed` class while it holds a tab.
 * That is enough for the policy in the README — the new client refuses to arm a
 * tab the old one has armed, and says so, rather than fighting it for the page.
 */
export const LEGACY_RING_HOST_ID = "aiui-webext-indicator-host";
