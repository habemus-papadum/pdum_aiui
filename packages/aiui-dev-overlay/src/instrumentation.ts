/**
 * Page-side instrumentation: the `window.__AIUI__` global the aiui DevTools
 * panel reads out of the inspected page (via `chrome.devtools.inspectedWindow`).
 *
 * Two things live here:
 *  - the **channel port** the page is using — seeded at serve time by the
 *    `aiuiDevOverlay()` Vite plugin (see vite.ts), read by the intent tool,
 *    and (re)recorded when the tool mounts. It is how both the tool and the
 *    panel discover which local server to talk to; and
 *  - a bounded ring of **frame metrics** — for every websocket frame the
 *    protocol client sends, its size and the ack round-trip time as *the page*
 *    experienced it. This is the client's half of transport observability; the
 *    server's half is `/debug/api/stats`.
 *
 * The global is a plain JSON-able object (the panel serializes it across the
 * eval boundary), versioned so the panel can detect shape changes. Everything
 * degrades to a no-op without a global scope, and the ring is bounded so an
 * idle tab never grows.
 */

/** One sent frame, as measured by the page. */
export interface FrameMetric {
  /** Epoch ms when the frame was sent. */
  at: number;
  /** The stream format the connection speaks. */
  format: string;
  kind: "hello" | "data";
  threadId?: string;
  fin?: boolean;
  /** Size of the encoded frame in bytes. */
  bytes: number;
  /** Ack round-trip time in milliseconds. */
  rttMs: number;
  ok: boolean;
  error?: string;
}

/** The shape of `window.__AIUI__`. */
export interface PageInstrumentation {
  /** Bump when this shape changes incompatibly. */
  v: 1;
  /** The channel server port the page is wired to, once known. */
  port?: number;
  /** The dev server's source root (seeded by the aiuiDevOverlay Vite plugin). */
  sourceRoot?: string;
  /** Recent frame metrics, oldest first (bounded ring). */
  frames: FrameMetric[];
}

declare global {
  interface Window {
    __AIUI__?: PageInstrumentation;
  }
}

/** How many frame metrics the ring keeps. */
const FRAME_LIMIT = 256;

/** Get (creating if needed) the page's instrumentation global. */
export function getInstrumentation(): PageInstrumentation | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }
  // Keep this initializer in sync with the inline script vite.ts injects.
  window.__AIUI__ ??= { v: 1, frames: [] };
  return window.__AIUI__;
}

/** Record the channel port the page is using (the panel's discovery hook). */
export function setChannelPort(port: number): void {
  const inst = getInstrumentation();
  if (inst) {
    inst.port = port;
  }
}

/** Append one frame metric to the ring. */
export function recordFrameMetric(metric: FrameMetric): void {
  const inst = getInstrumentation();
  if (!inst) {
    return;
  }
  inst.frames.push(metric);
  if (inst.frames.length > FRAME_LIMIT) {
    inst.frames.splice(0, inst.frames.length - FRAME_LIMIT);
  }
}

/**
 * The browser tab this page lives in — local mirror of the channel package's
 * `TabInfo` (this package stays dependency-free; web.test.ts cross-checks the
 * shape against the real server).
 */
export interface TabInfo {
  url?: string;
  title?: string;
  chromeTabId?: number;
  windowId?: number;
  tabIndex?: number;
  targetId?: string;
}

/** The client context sent on a connection's hello (mirror of `HelloMeta`). */
export interface ClientMeta {
  tab?: TabInfo;
  source?: { root?: string };
  /**
   * The `intent-v1` client's effective `IntentPipelineConfig` (JSON-serializable
   * view), so a lowering trace records the whole configuration the events were
   * produced under. Opaque here — the modality supplies it, the channel reads it.
   */
  intent?: Record<string, unknown>;
}

/**
 * The `document.documentElement` dataset key (as a data attribute:
 * `data-aiui-tab`) where the aiui DevTools extension stamps this tab's
 * identity — `{ chromeTabId, windowId, tabIndex, targetId }` as JSON. The
 * extension writes it from its background worker (only it can know tab ids);
 * we read it lazily at send time.
 */
export const TAB_DATASET_KEY = "aiuiTab";

/**
 * Collect what this page knows about itself for a connection's hello: live
 * URL/title, the extension-stamped tab identity (if the aiui DevTools
 * extension is installed), and the plugin-seeded source root. Degrades to
 * whatever subset exists — returns undefined outside a DOM.
 */
export function collectClientMeta(): ClientMeta | undefined {
  if (typeof document === "undefined" || typeof location === "undefined") {
    return undefined;
  }
  const tab: TabInfo = { url: location.href, title: document.title };
  const stamped = document.documentElement.dataset[TAB_DATASET_KEY];
  if (stamped !== undefined) {
    try {
      const ids = JSON.parse(stamped) as Record<string, unknown>;
      if (typeof ids.chromeTabId === "number") {
        tab.chromeTabId = ids.chromeTabId;
      }
      if (typeof ids.windowId === "number") {
        tab.windowId = ids.windowId;
      }
      if (typeof ids.tabIndex === "number") {
        tab.tabIndex = ids.tabIndex;
      }
      if (typeof ids.targetId === "string") {
        tab.targetId = ids.targetId;
      }
    } catch {
      // A malformed stamp never blocks sending — the live url/title suffice.
    }
  }
  const sourceRoot = getInstrumentation()?.sourceRoot;
  return {
    tab,
    ...(sourceRoot !== undefined ? { source: { root: sourceRoot } } : {}),
  };
}
