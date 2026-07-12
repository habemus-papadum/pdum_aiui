/**
 * Content script: the extension's entire in-page footprint. Per the §13.6
 * model the page carries ONLY what should be capturable — the indicator ring
 * (armed steady / in-turn breathing), the ink, and the transient feedback
 * flashes. No pill, no badge, no hints: every control lives in the side
 * panel. Modes are the PANEL's state; this script obeys relay commands and
 * reports facts back (strokes, selection presence, boot hello).
 *
 * Ink is page content by design (§5): strokes land in tab captures natively.
 * Strokes are DOCUMENT-anchored (§13.6 divergence 4): they follow the page as
 * it scrolls, persist per-tab across turn ends / mode exits / resizes / tab
 * switches, and are cleared only by the panel's clear relay (C / disarm).
 *
 * ## HMR
 *
 * CRXJS hot-swaps this module in place. State that must survive a swap lives
 * on `window` (the ink-mode flag — the fresh module remounts the surface,
 * strokes excepted); `import.meta.hot.accept` re-runs the module, and the
 * boot hello re-pulls panel state so ring/capture re-sync.
 */
import { installSelectionWatcher } from "@habemus-papadum/aiui-dev-overlay/selection";
import { boundsOf, InkSurface } from "@habemus-papadum/aiui-ink";
import { mountIndicator, serveRelay } from "@habemus-papadum/aiui-webext";

interface HmrStash {
  /** Ink MODE survives a content-script hot swap (remounted at module init);
   * it dies with the document, like the strokes themselves. */
  ink?: { fadeSec: number };
}

declare global {
  interface Window {
    __aiuiExtStash?: HmrStash;
  }
}

window.__aiuiExtStash ??= {};
const stash: HmrStash = window.__aiuiExtStash;

const indicator = mountIndicator();

// ── ink: the per-tab, document-anchored layer ───────────────────────────────
// The surface can outlive ink MODE (pointer claim): leaving the mode keeps
// the strokes on screen; only the panel's clear relay (C / disarm) or the
// fade removes them (§13.6: "C or disarm. Nothing else").

const INK_HOST_ID = "aiui-webext-ink-host";

let ink: { surface: InkSurface; host: HTMLElement } | undefined;
/** Ink MODE (pointer captured) — distinct from strokes existing. */
let inkActive = false;
/** The live fade lifetime — the surface reads it per frame, so the panel's
 * fade slider takes effect on EXISTING strokes without a remount. */
let inkFadeSec = 0;

const mountInk = (fadeSec: number): void => {
  inkFadeSec = fadeSec;
  if (ink !== undefined) {
    // A kept-strokes surface from an earlier mode: re-enter over it (the
    // fade update above already applies — the surface reads the live var).
    ink.surface.setActive(true);
    inkActive = true;
    return;
  }
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
    fadeSec: () => inkFadeSec,
    documentAnchored: true, // strokes follow the page, not the viewport (§13.6)
    onStrokeEnd: (stroke) => {
      // Stroke facts relay up as raw broadcasts (structured — the
      // defer-rendering rule); the PANEL decides whether a turn is open to
      // receive them. Bounds are reported in VIEWPORT coordinates (the
      // engine's Rect space): document coords minus the live scroll.
      const doc = boundsOf(stroke.points);
      chrome.runtime
        .sendMessage({
          aiuiStroke: 1,
          points: stroke.points.length,
          bounds: { ...doc, x: doc.x - window.scrollX, y: doc.y - window.scrollY },
        })
        .catch(() => {});
    },
    onRemoteStrokeEnd: (_id, points) => {
      // An iPad stroke joins the turn exactly like a local one (C7): same
      // relay, same viewport-space bounds.
      const doc = boundsOf(points);
      chrome.runtime
        .sendMessage({
          aiuiStroke: 1,
          points: points.length,
          bounds: { ...doc, x: doc.x - window.scrollX, y: doc.y - window.scrollY },
        })
        .catch(() => {});
    },
    onAutoClear: () => {
      chrome.runtime.sendMessage({ aiuiInkClear: 1 }).catch(() => {});
      if (!inkActive) {
        unmountInk(); // faded away after mode exit — nothing left to keep
      }
    },
  });
  surface.setActive(true); // ink mode owns the pointer while on — that is the mode
  inkActive = true;
  ink = { surface, host };
};

/** Leave ink MODE: release the pointer, keep the strokes on screen. */
const deactivateInk = (): void => {
  inkActive = false;
  ink?.surface.setActive(false);
};

/** Erase the strokes (panel-initiated — C or disarm; the panel does its own
 * bookkeeping, so `clear(false)` stays silent). Off-mode, unmount. */
const clearInk = (): void => {
  ink?.surface.clear(false);
  if (!inkActive) {
    unmountInk();
  }
};

const unmountInk = (): void => {
  if (ink !== undefined) {
    ink.surface.dispose();
    ink.host.remove();
    ink = undefined;
    inkActive = false;
  }
};

if (stash.ink !== undefined) {
  mountInk(stash.ink.fadeSec); // an HMR swap mid-ink: remount (strokes are gone)
}

// ── selection: PULL model (§13.5 — explicit, never ambient) ─────────────────
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

// ── the in-turn key capture (panel-driven) ──────────────────────────────────
// On ONLY while a turn is open (§13.6: capture is per-turn, not per-armed).
// Every non-modifier key is swallowed synchronously and the keydown forwards
// to the panel — the brain resolves it against the grammar (leader.ts).

const LEADER_MODIFIERS = new Set([
  "Shift",
  "Control",
  "Alt",
  "Meta",
  "CapsLock",
  "NumLock",
  "ScrollLock",
  "AltGraph",
  "Fn",
  "Dead",
]);

let keylayerOff: (() => void) | undefined;

const keylayerOn = (): void => {
  if (keylayerOff !== undefined) {
    return;
  }
  const onKey = (event: KeyboardEvent): void => {
    if (event.type === "keydown" && LEADER_MODIFIERS.has(event.key)) {
      return; // modifiers stay the browser's — the leader chord's own keys
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.type === "keydown" && !event.repeat) {
      chrome.runtime.sendMessage({ aiuiLeaderKey: 1, key: event.key }).catch(() => {});
    }
  };
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("keyup", onKey, true);
  keylayerOff = () => {
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("keyup", onKey, true);
    keylayerOff = undefined;
  };
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
  /**
   * Ink, panel-driven. `on: true` enters the mode (mounting or re-entering a
   * kept surface); `on: false` leaves the MODE but keeps the strokes;
   * `clear: true` erases them (C / disarm).
   */
  ink: (payload) => {
    const p = payload as { on?: boolean; fadeSec?: number; clear?: boolean };
    if (p.clear === true) {
      clearInk();
    }
    if (p.on === true) {
      mountInk(p.fadeSec ?? 0);
      stash.ink = { fadeSec: p.fadeSec ?? 0 };
    } else if (p.on === false) {
      deactivateInk();
      stash.ink = undefined;
    }
    return inkActive;
  },
  /** The in-turn key capture, panel-driven. */
  keylayer: (payload) => {
    const p = payload as { on?: boolean };
    if (p.on === true) {
      keylayerOn();
    } else {
      keylayerOff?.();
    }
    return keylayerOff !== undefined;
  },
  /** Viewport feedback washes: "miss" (swallowed typo) and "shot" (post-grab). */
  flash: (payload) => {
    const p = payload as { kind?: string };
    indicator.flash(p.kind === "shot" ? "shot" : "miss");
    return true;
  },
});

// ── ring state: driven by the panel (per-window broadcast) ──────────────────
// Smart video's gate: a throttled "the user touched the page" ping. One-way,
// cheap (>=500ms apart), consumed by the panel's sampler tick (§13.6: smart
// frames follow interaction, never a metronome).
let lastInteractPing = 0;
const pingInteract = (): void => {
  const now = Date.now();
  if (now - lastInteractPing < 500) {
    return;
  }
  lastInteractPing = now;
  chrome.runtime.sendMessage({ aiuiInteract: 1 }).catch(() => {});
};
for (const type of ["pointerdown", "keyup", "wheel", "scroll"] as const) {
  window.addEventListener(type, pingInteract, { passive: true, capture: true });
}

// Remote ink (C7): the panel's paint host forwards iPad strokes as one-way
// ops in TAB CSS pixels. They land on the SAME surface local drawing uses —
// mounted on demand (remote ink needs no local ink MODE; the pointer claim is
// untouched: activateInk/deactivateInk still own setActive).
const remoteInkOp = (m: {
  op: "begin" | "point" | "end" | "cancel";
  id: string;
  style?: { color: string; width: number };
  point?: { x: number; y: number };
}): void => {
  if (ink === undefined) {
    const wasOn = inkActive; // mountInk claims the pointer; restore intent
    mountInk(inkFadeSec);
    if (!wasOn) {
      deactivateInk(); // mounted for remote strokes only — no pointer claim
    }
  }
  const surface = ink?.surface;
  if (surface === undefined) {
    return;
  }
  if (m.op === "begin" && m.style && m.point) {
    surface.remoteBegin(m.id, { style: m.style, point: m.point });
  } else if (m.op === "point" && m.point) {
    surface.remotePoint(m.id, m.point);
  } else if (m.op === "end") {
    surface.remoteEnd(m.id, m.point);
  } else if (m.op === "cancel") {
    surface.remoteCancel(m.id);
  }
};

chrome.runtime.onMessage.addListener((msg) => {
  if (
    msg !== null &&
    typeof msg === "object" &&
    (msg as { aiuiRemoteInk?: number }).aiuiRemoteInk === 1
  ) {
    remoteInkOp(msg as never);
    return false;
  }
  if (msg !== null && typeof msg === "object" && (msg as { aiuiRing?: number }).aiuiRing === 1) {
    const m = msg as { armed?: boolean; turn?: boolean };
    indicator.set({ armed: m.armed === true, turn: m.turn === true });
  }
  return false;
});

// Boot hello: pull the window's tool state instead of waiting for the next
// push. A fresh document (navigation, new tab, HMR swap) knows nothing — the
// panel answers with the ring state and, if a turn is open on this active
// tab, re-points the key capture here. Without this, state silently didn't
// survive navigations (found live 2026-07-11; the back button "fixing" it was
// bfcache resurrecting old listeners).
chrome.runtime.sendMessage({ aiuiPageHello: 1 }).catch(() => {});

console.info("aiui-extension: content script mounted");

if (import.meta.hot) {
  // Self-accept: the swap re-runs this module, which replaces the indicator
  // host wholesale and re-pulls state via the hello above.
  import.meta.hot.accept();
}
