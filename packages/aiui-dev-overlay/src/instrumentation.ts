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
  /**
   * Who is driving the page: `"human"` (the default), `"agent"`, or an explicit
   * label. Trace provenance — the channel stamps it on the trace manifest so
   * agent-driven UI testing is distinguishable from a person in the trace list.
   * Always an explicit opt-in, never a heuristic — see {@link collectClientMeta}
   * for the rules and {@link ACTOR_STORAGE_KEY} for the per-tab toggle.
   */
  actor?: string;
}

/**
 * The `document.documentElement` dataset key (as a data attribute:
 * `data-aiui-tab`) where the aiui DevTools extension stamps this tab's
 * identity — `{ chromeTabId, windowId, tabIndex, targetId }` as JSON. The
 * extension writes it from its background worker (only it can know tab ids);
 * we read it lazily at send time.
 */
export const TAB_DATASET_KEY = "aiuiTab";

/** Options for {@link collectClientMeta}. */
export interface CollectClientMetaOptions {
  /**
   * Explicit actor label riding the hello as `meta.actor`; wins over the
   * per-tab {@link ACTOR_STORAGE_KEY} toggle. Pass it when a harness knows who
   * it is (a named bot, a recorded demo).
   */
  actor?: string;
}

/**
 * The sessionStorage key that relabels this **tab's** turns: set it to
 * `"agent"` (or any label) and every subsequent hello from this tab carries
 * that actor; remove it to fall back to `"human"`.
 *
 * This is the whole opt-in mechanism, and it is deliberately not a heuristic.
 * The obvious heuristic — `navigator.webdriver` — is browser-wide: the shared
 * session browser (Chrome for Testing, launched for CDP) sets it for the
 * human's tabs and the agent's tabs alike, so it labeled *people* as agents.
 * Per-tab storage matches how the browser is actually shared (the agent
 * drives its own tab), survives reloads within that tab, and dies with it.
 * An agent (or a CI harness) flips it with one evaluate:
 *
 *   sessionStorage.setItem("aiui-actor", "agent")
 *
 * Mislabeling tolerance is asymmetric by design: an unflagged agent turn
 * showing as `human` is acceptable; a person's turn showing as `agent` was
 * the bug that retired the heuristic.
 */
export const ACTOR_STORAGE_KEY = "aiui-actor";

/**
 * Collect what this page knows about itself for a connection's hello: live
 * URL/title, the extension-stamped tab identity (if the aiui DevTools
 * extension is installed), the plugin-seeded source root, and the actor label
 * (who is driving the page). Degrades to whatever subset exists — returns
 * undefined outside a DOM.
 */
export function collectClientMeta(options: CollectClientMetaOptions = {}): ClientMeta | undefined {
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
    actor: options.actor ?? currentActor(),
  };
}

/**
 * The actor label: an explicit option always wins (see
 * {@link CollectClientMetaOptions}); then the per-tab opt-in toggle
 * ({@link ACTOR_STORAGE_KEY}); else `"human"`. Never inferred — see the key's
 * doc for why the `navigator.webdriver` heuristic was retired.
 */
function currentActor(): string {
  try {
    const stored =
      typeof sessionStorage !== "undefined" ? sessionStorage.getItem(ACTOR_STORAGE_KEY) : null;
    if (stored !== null && stored !== "") {
      return stored;
    }
  } catch {
    // Storage access can throw (sandboxed frames) — the default covers it.
  }
  return "human";
}
