/**
 * Content script: the extension's entire in-page footprint. Panel-first design
 * (browser-extension-intent-tool.md §1): no widget, no command bar — just the
 * minimal indicator (armed ring + dot), the selection watcher, and the ink
 * layer. Modes are the PANEL's state; this script only obeys relay commands
 * (`ink on/off`) and reports facts back (strokes, selection presence).
 *
 * Ink is page content by design (§5): strokes land in tab captures natively,
 * so there is no compositing code anywhere on the extension path.
 *
 * ## HMR (the step-1 checkpoint)
 *
 * CRXJS hot-swaps this module in place. Two rules keep that useful:
 *  - state that must survive a swap lives on `window` (the click counter, the
 *    ink-mode flag — the fresh module remounts the surface, strokes excepted);
 *  - `import.meta.hot.accept` remounts the indicator from the fresh module, so
 *    an edit is visible without a page reload and without losing the counter.
 */
import { installSelectionWatcher } from "@habemus-papadum/aiui-dev-overlay/selection";
import { boundsOf, InkSurface } from "@habemus-papadum/aiui-ink";
import { mountIndicator, serveRelay } from "@habemus-papadum/aiui-webext";

/** Edit me for an HMR check: the indicator badge should update in place. */
const BADGE = "aiui";

interface HmrStash {
  clicks: number;
  /** Ink mode survives a content-script hot swap (remounted at module init);
   * it dies with the document, like the strokes themselves. */
  ink?: { fadeSec: number };
}

declare global {
  interface Window {
    __aiuiExtStash?: HmrStash;
  }
}

window.__aiuiExtStash ??= { clicks: 0 };
const stash: HmrStash = window.__aiuiExtStash;

const indicator = mountIndicator();
const show = (): void => {
  indicator.set({
    armed: false,
    mode: "",
    badge: stash.clicks > 0 ? `${BADGE} · ${stash.clicks}` : BADGE,
  });
};
indicator.onClick(() => {
  stash.clicks += 1;
  show();
});
show();

// ── ink: the per-tab layer (explicitly entered from the panel) ──────────────
// Same shadow-DOM style as the indicator; the layer sits UNDER the indicator's
// ring/dot (z-index −1) so "armed" stays readable over ink. Stroke facts relay
// up as raw broadcasts (structured — the defer-rendering rule); the panel owns
// the engine and the turn.

const INK_HOST_ID = "aiui-webext-ink-host";

let ink: { surface: InkSurface; host: HTMLElement } | undefined;

const mountInk = (fadeSec: number): void => {
  unmountInk();
  document.getElementById(INK_HOST_ID)?.remove(); // stale host from a torn-down script (HMR)
  const host = document.createElement("div");
  host.id = INK_HOST_ID;
  const shadow = host.attachShadow({ mode: "open" });
  const layer = document.createElement("div");
  layer.style.cssText = "position: fixed; inset: 0; z-index: 2147483645; pointer-events: none;";
  shadow.append(layer);
  document.documentElement.append(host);
  const surface = new InkSurface({
    target: layer,
    fadeSec: () => fadeSec,
    onStrokeEnd: (stroke) => {
      chrome.runtime
        .sendMessage({
          aiuiStroke: 1,
          points: stroke.points.length,
          bounds: boundsOf(stroke.points),
        })
        .catch(() => {});
    },
    onAutoClear: () => {
      chrome.runtime.sendMessage({ aiuiInkClear: 1 }).catch(() => {});
    },
  });
  surface.setActive(true); // ink mode owns the pointer while on — that is the mode
  ink = { surface, host };
  indicator.set({ mode: "ink" });
};

const unmountInk = (): void => {
  if (ink !== undefined) {
    ink.surface.dispose();
    ink.host.remove();
    ink = undefined;
    indicator.set({ mode: "" });
  }
};

if (stash.ink !== undefined) {
  mountInk(stash.ink.fadeSec); // an HMR swap mid-ink: remount (strokes are gone)
}

// ── selection: PULL model (decided 2026-07-11 — explicit, never ambient).
// The watcher only keeps the freshest snapshot warm; nothing enters the turn
// until the panel asks (the user's "add selection" command). A lightweight
// presence ping lets the panel show its affordance; the payload travels only
// on request, structured (defer-rendering rule).
const watcher = installSelectionWatcher({
  onChange: (snap) => {
    chrome.runtime
      .sendMessage({ aiuiSelectionPresence: 1, present: snap !== undefined })
      .catch(() => {});
  },
});

const toPayload = (snap: ReturnType<typeof watcher.snapshot>) =>
  snap === undefined
    ? null
    : {
        text: snap.text,
        ...(snap.sourceLoc !== undefined ? { sourceLoc: snap.sourceLoc } : {}),
        ...(snap.cell !== undefined ? { cell: snap.cell } : {}),
        ...(snap.cellLoc !== undefined ? { cellLoc: snap.cellLoc } : {}),
        ...(snap.tex !== undefined ? { tex: snap.tex } : {}),
        ...(snap.url !== "" ? { url: snap.url } : {}),
      };

serveRelay("page", {
  /** The panel's slurp command: the current selection, structured, or null. */
  selection: () => toPayload(watcher.snapshot()),
  /** The page's own viewport (CSS px + dpr) — the capture-constraint truth. */
  viewport: () => ({
    w: window.innerWidth,
    h: window.innerHeight,
    dpr: window.devicePixelRatio || 1,
  }),
  /** Ink mode, panel-driven: on mounts the surface, off clears + unmounts. */
  ink: (payload) => {
    const p = payload as { on?: boolean; fadeSec?: number };
    if (p.on === true) {
      mountInk(p.fadeSec ?? 0);
      stash.ink = { fadeSec: p.fadeSec ?? 0 };
    } else {
      unmountInk();
      stash.ink = undefined;
    }
    return ink !== undefined;
  },
});

// ── armed indicator: driven by the panel (per-window broadcast) ─────────────
chrome.runtime.onMessage.addListener((msg) => {
  if (msg !== null && typeof msg === "object" && (msg as { aiuiArm?: number }).aiuiArm === 1) {
    indicator.set({ armed: (msg as { armed?: boolean }).armed === true });
  }
  return false;
});

console.info(`aiui-extension: content script mounted (badge "${BADGE}", clicks ${stash.clicks})`);

if (import.meta.hot) {
  // Self-accept: the swap re-runs this module, which replaces the indicator
  // host wholesale (mountIndicator sweeps the stale one) and re-reads the
  // stash — an in-place update, page state untouched.
  import.meta.hot.accept();
}
