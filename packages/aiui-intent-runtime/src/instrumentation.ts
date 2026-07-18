/**
 * Page-side instrumentation: the `window.__AIUI__` global — the page-realm
 * mark that a page is an aiui app, and the carrier of the dev server's source
 * root (seeded by the `aiui()` source-processor plugin) that attribution
 * consumers resolve stamped paths against.
 *
 * The global is a plain JSON-able object, versioned so readers can detect
 * shape changes. Everything degrades to a no-op without a global scope.
 */

import type { TabInfo, TabRecord } from "@habemus-papadum/aiui-lowering-pipeline";

/** The shape of `window.__AIUI__`. */
export interface PageInstrumentation {
  /** Bump when this shape changes incompatibly. */
  v: 1;
  /** The dev server's source root (seeded by the `aiui()` source-processor plugin). */
  sourceRoot?: string;
}

declare global {
  interface Window {
    __AIUI__?: PageInstrumentation;
  }
}

/**
 * The wire shape of a tab record — an alias of the lowering pipeline's
 * {@link TabRecord}. The type-only import erases at compile time, so it does
 * NOT endanger the stringification of {@link pageTabRecord} below: only that
 * FUNCTION carries the self-contained-by-contract constraint, and its body
 * references no types.
 */
export type PageTabRecord = TabRecord;

/**
 * The canonical tab record for the CURRENT page — the ONE builder both intent
 * hosts use to describe a tab on selection/navigation events (the lowering
 * pipeline renders it as the `<tab …/>` element).
 *
 * SELF-CONTAINED BY CONTRACT: the CDP host injects this function into driven
 * pages by STRINGIFYING it (see the intent client's `buildPageScript`), so its
 * body must reference nothing outside itself — no imports, no module consts,
 * no other functions. The extension's content script imports and calls it
 * directly; there it runs in the ISOLATED world, where the page-realm
 * `window.__AIUI__` is invisible but the DOM footprint (stamped
 * `data-source-loc` / `data-cell` attributes) still marks an aiui app —
 * `sourceRoot` is page-realm-only and simply stays absent.
 *
 * Detection READS the global, never creates it — {@link getInstrumentation}
 * would mint `__AIUI__` on a page that has no aiui at all.
 */
export function pageTabRecord(): PageTabRecord | undefined {
  if (typeof location === "undefined" || typeof document === "undefined") {
    return undefined;
  }
  const record: PageTabRecord = { url: location.href };
  if (document.title !== "") {
    record.title = document.title;
  }
  const inst =
    typeof window === "undefined"
      ? undefined
      : (window as { __AIUI__?: { sourceRoot?: string } }).__AIUI__;
  if (inst !== undefined) {
    record.aiui = true;
    if (typeof inst.sourceRoot === "string") {
      record.sourceRoot = inst.sourceRoot;
    }
  } else if (document.querySelector("[data-source-loc],[data-cell]") !== null) {
    record.aiui = true;
  }
  return record;
}

/** Get (creating if needed) the page's instrumentation global. */
export function getInstrumentation(): PageInstrumentation | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }
  // Keep this initializer in sync with the inline seed the `aiui()` plugin
  // injects (@habemus-papadum/aiui-source-processor).
  window.__AIUI__ ??= { v: 1 };
  return window.__AIUI__;
}

/**
 * The browser tab this page lives in — the shared {@link TabInfo} from the
 * lowering pipeline (a {@link TabRecord} projection), which is also the
 * channel's hello-meta `tab` shape. Re-exported so this module's consumers keep
 * one import site; the type-only import erases at compile time.
 */
export type { TabInfo };

/**
 * The client context sent on a connection's hello — a mirror of the channel's
 * `HelloMeta`. Kept in step by protocol.test.ts, which asserts every ClientMeta
 * is assignable to HelloMeta and round-trips a collectClientMeta()-shaped value
 * through the channel's frame decoder.
 */
export interface ClientMeta {
  tab?: TabInfo;
  source?: { root?: string };
  /**
   * The `intent-v1` client's effective `IntentPipelineConfig` (JSON-serializable
   * view), so a lowering trace records the whole configuration the events were
   * produced under. Opaque here — the host supplies it, the channel reads it.
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
 * URL/title, the plugin-seeded source root, and the actor label (who is
 * driving the page). Degrades to whatever subset exists — returns undefined
 * outside a DOM. (Tab identity — chromeTabId and friends — is supplied by the
 * HOST when it has one: the MV3 extension asks `chrome.tabs`, the CDP tier
 * asks the browser; a bare page cannot know it.)
 */
export function collectClientMeta(options: CollectClientMetaOptions = {}): ClientMeta | undefined {
  if (typeof document === "undefined" || typeof location === "undefined") {
    return undefined;
  }
  const tab: TabInfo = { url: location.href, title: document.title };
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
