/**
 * Capture wire shapes + pure helpers shared by the panel and the service
 * worker. The pixel work lives in the PANEL (src/panel/capture.ts) — the SW
 * only mints stream ids (measured 2026-07-12: a side panel can consume a
 * tabCapture stream directly, so the offscreen capture room is gone).
 */

/** The panel's ask to the SW: a stream id for this tab. */
export interface StreamIdRequest {
  tabId: number;
}

/** The SW's answer. */
export interface StreamIdReply {
  streamId: string;
}

/**
 * The tabCapture invocation gate, recognized by its measured error string
 * (RESULTS.md M4a): "Extension has not been invoked for the current page
 * (see activeTab permission). Chrome pages cannot be captured." The remedy is
 * an invocation on that tab — ⌘B counts (measured M8), which is exactly what
 * opening a turn does.
 */
export function isNotInvokedError(message: string): boolean {
  return /has not been invoked/i.test(message);
}
