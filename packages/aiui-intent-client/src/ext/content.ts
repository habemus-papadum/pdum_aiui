/**
 * content.ts — the extension's entire in-page footprint (the CDP tier's
 * `page-script.ts`, wearing the other transport).
 *
 * The page carries ONLY what should be capturable — the ring, the ink, the
 * feedback flashes. No pill, no badge, no hints: every control lives in the
 * panel. Modes are the PANEL's state; this script obeys capability commands and
 * reports facts back. It speaks the same `PageReport` union the injected CDP
 * bootstrap speaks, so both hosts map page facts with one vocabulary.
 *
 * Being a real module (Vite bundles it) buys what the CDP bootstrap could not
 * have: it *imports* the ink surface (`../cdp/page-ink`) instead of having a
 * bundle evaluated into it, and it imports the overlay's selection watcher, so
 * selections here are STRUCTURED (source locators, cell ids, TeX) rather than
 * plain text.
 *
 * What it cannot have, and where those facts come from instead:
 *  - **`window.__AIUI__`** — a content script lives in an isolated world, so the
 *    page's own globals are invisible. A tiny MAIN-world script
 *    (`content-main.ts`) probes it and posts the answer over here.
 *  - **SPA navigations** — `history.pushState` happens in the page's realm;
 *    wrapping ours would see nothing. The service worker watches
 *    `chrome.webNavigation` instead, which is the browser's own answer.
 *
 * The ring/flash visuals are deliberately mirrored from `cdp/page-script.ts`
 * (same ids, same look). They cannot be shared: that bootstrap is stringified
 * for injection and so may not import anything at all.
 */

import { locateComponents } from "@habemus-papadum/aiui-dev-overlay/multimodal-shot";
import { installSelectionWatcher } from "@habemus-papadum/aiui-dev-overlay/selection";
import { serveRelay } from "@habemus-papadum/aiui-webext";
import { type InkHandle, mountInk, mountPencil, type PencilHandle } from "../cdp/page-ink";
import type { PageReport } from "../cdp/page-script";
import { LEGACY_RING_HOST_ID, PAGE_ADDRESS, type ReportMessage } from "./protocol";

const report = (r: PageReport): void => {
  const message: ReportMessage = { aiuiIntentReport: 1, report: r };
  chrome.runtime.sendMessage(message).catch(() => {
    // No panel open (or the extension reloaded): facts are re-reported on the
    // next hello, so a dropped one is never load-bearing.
  });
};

// ── the ring: the page's ONLY evidence of the client's state ─────────────────
// Four states: off · steady (armed) · breathing (turn) · HOLLOW — armed, but
// this tab's pixels need a grant (the fourth state matters most HERE: MV3's
// grant is per-tab, so every tab switch lands on an ungranted page). Hollow is
// outline-only with the activation hint beside it; the hint text is whatever
// the host handed down (the live chrome.commands binding) — this script never
// knows what the key is.
const RING_ID = "__aiui-intent-ring";
let ring: HTMLElement | undefined;
let ringHint: HTMLElement | undefined;
const assertRing = (on: boolean, turnTone: boolean, hollow: boolean, hint: string): void => {
  if (!on) {
    ring?.remove();
    ringHint?.remove();
    ring = undefined;
    ringHint = undefined;
    return;
  }
  if (ring === undefined || !ring.isConnected) {
    ring = document.createElement("div");
    ring.id = RING_ID;
    ring.style.cssText =
      "position:fixed;top:8px;right:8px;width:12px;height:12px;border-radius:50%;" +
      "box-sizing:border-box;z-index:2147483646;pointer-events:none;transition:background 200ms;";
    const style = document.createElement("style");
    style.textContent =
      "@keyframes __aiui-breathe{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.5;transform:scale(.8)}}";
    ring.appendChild(style);
    (document.body ?? document.documentElement).appendChild(ring);
  }
  const color = turnTone ? "#dc2626" : "#7c3aed";
  ring.style.background = hollow ? "transparent" : color;
  ring.style.border = hollow ? `2px solid ${color}` : "0";
  ring.style.animation = turnTone ? "__aiui-breathe 1.6s ease-in-out infinite" : "none";
  if (hollow && hint !== "") {
    if (ringHint === undefined || !ringHint.isConnected) {
      ringHint = document.createElement("div");
      ringHint.id = `${RING_ID}-hint`;
      ringHint.style.cssText =
        "position:fixed;top:7px;right:24px;z-index:2147483646;pointer-events:none;" +
        "font:11px/14px ui-monospace,SFMono-Regular,Menlo,monospace;padding:0 5px;" +
        "border-radius:7px;background:rgba(0,0,0,.55);color:#fff;";
      (document.body ?? document.documentElement).appendChild(ringHint);
    }
    ringHint.textContent = hint;
  } else {
    ringHint?.remove();
    ringHint = undefined;
  }
};

const flash = (kind: string): void => {
  const wash = document.createElement("div");
  wash.style.cssText =
    "position:fixed;inset:0;z-index:2147483647;pointer-events:none;transition:opacity 220ms;" +
    `background:${kind === "miss" ? "rgba(220,38,38,.25)" : "rgba(147,197,253,.35)"};`;
  (document.body ?? document.documentElement).appendChild(wash);
  requestAnimationFrame(() => {
    wash.style.opacity = "0";
    setTimeout(() => wash.remove(), 260);
  });
};

// ── the in-turn key layer (the wholesale claim) ──────────────────────────────
let keyHandlers: { down: (e: KeyboardEvent) => void; up: (e: KeyboardEvent) => void } | undefined;
const setKeyCapture = (capture: boolean): void => {
  if (!capture) {
    if (keyHandlers !== undefined) {
      window.removeEventListener("keydown", keyHandlers.down, true);
      window.removeEventListener("keyup", keyHandlers.up, true);
      keyHandlers = undefined;
    }
    return;
  }
  if (keyHandlers !== undefined) {
    return;
  }
  const forward = (phase: "down" | "up") => (event: KeyboardEvent) => {
    // Browser chords (⌘L, ⌘T…) stay the browser's — the wholesale claim is for
    // ordinary keys; the panel's grammar decides swallow-vs-command.
    if (event.metaKey || event.ctrlKey || event.altKey) {
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    report({ kind: "key", key: event.key, phase, repeat: event.repeat });
  };
  keyHandlers = { down: forward("down"), up: forward("up") };
  window.addEventListener("keydown", keyHandlers.down, true);
  window.addEventListener("keyup", keyHandlers.up, true);
};

// ── the region rubber band: a ONE-SHOT drag overlay (the `a` area shot) ──────
let regionOverlay: HTMLElement | undefined;
const disarmRegion = (): void => {
  regionOverlay?.remove();
  regionOverlay = undefined;
};
const armRegion = (): void => {
  disarmRegion(); // re-arm replaces
  const overlay = document.createElement("div");
  overlay.id = "__aiui-intent-region";
  overlay.style.cssText =
    "position:fixed;inset:0;z-index:2147483646;cursor:crosshair;background:rgba(124,58,237,.06);";
  const band = document.createElement("div");
  band.style.cssText =
    "position:fixed;border:2px solid #7c3aed;background:rgba(124,58,237,.12);display:none;" +
    "pointer-events:none;";
  overlay.appendChild(band);
  let start: { x: number; y: number } | undefined;
  const rectNow = (e: PointerEvent) => {
    const s0 = start ?? { x: e.clientX, y: e.clientY };
    return {
      x: Math.min(s0.x, e.clientX),
      y: Math.min(s0.y, e.clientY),
      w: Math.abs(e.clientX - s0.x),
      h: Math.abs(e.clientY - s0.y),
    };
  };
  overlay.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    start = { x: e.clientX, y: e.clientY };
    overlay.setPointerCapture(e.pointerId);
  });
  overlay.addEventListener("pointermove", (e) => {
    if (start === undefined) {
      return;
    }
    const r = rectNow(e);
    band.style.display = "block";
    band.style.left = `${r.x}px`;
    band.style.top = `${r.y}px`;
    band.style.width = `${r.w}px`;
    band.style.height = `${r.h}px`;
  });
  overlay.addEventListener("pointerup", (e) => {
    const r = start !== undefined ? rectNow(e) : undefined;
    disarmRegion();
    if (r === undefined || r.w < 4 || r.h < 4) {
      return; // a click, not a drag — cancelled
    }
    // The locator reads DOM attributes (data-source-loc stamps), which the
    // isolated world sees fine; only window.__AIUI__ globals are main-world.
    let components: unknown[] | undefined;
    try {
      components = locateComponents(r);
    } catch {
      components = undefined;
    }
    report({
      kind: "region",
      rect: r,
      viewport: { w: window.innerWidth, h: window.innerHeight },
      takenAt: Date.now(),
      ...(components !== undefined && components.length > 0 ? { components } : {}),
    });
  });
  const onEsc = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.stopImmediatePropagation();
      disarmRegion();
      document.removeEventListener("keydown", onEsc, true);
    }
  };
  document.addEventListener("keydown", onEsc, true);
  (document.body ?? document.documentElement).appendChild(overlay);
  regionOverlay = overlay;
};

// ── ink: the real surface, imported (no injection, no CSP fight) ─────────────
let ink: InkHandle | undefined;

// ── pencil: a second surface, local stylus + forwarded iPad strokes ──────────
let pencil: PencilHandle | undefined;

// ── selection: structured, via the overlay's watcher ─────────────────────────
const watcher = installSelectionWatcher({
  onChange: (snap) => report({ kind: "selection", present: snap !== undefined }),
});

// ── the coexistence detector (see protocol.ts) ───────────────────────────────
// The frozen client injects into the same page. We cannot talk to it — runtime
// messages never cross extension ids — but we share a DOM, and its ring wears
// an `armed` class while it holds the tab. Watch that, report it, and let the
// panel refuse to arm on top of it (README: never both armed).
const legacyArmed = (): boolean => {
  const host = document.getElementById(LEGACY_RING_HOST_ID);
  const root = host?.shadowRoot?.firstElementChild?.nextElementSibling ?? undefined;
  return root instanceof HTMLElement ? root.classList.contains("armed") : false;
};
let foreignWas = false;
const checkForeign = (): void => {
  const armed = legacyArmed();
  if (armed !== foreignWas) {
    foreignWas = armed;
    report({ kind: "foreign", armed });
  }
};
const legacyHost = document.getElementById(LEGACY_RING_HOST_ID);
if (legacyHost?.shadowRoot != null) {
  new MutationObserver(checkForeign).observe(legacyHost.shadowRoot, {
    attributes: true,
    subtree: true,
    attributeFilter: ["class"],
  });
}

// ── the interaction ping (the smart-video gate) ──────────────────────────────
let lastInteraction = 0;
const interaction = (): void => {
  const now = Date.now();
  if (now - lastInteraction > 1000) {
    lastInteraction = now;
    report({ kind: "interaction" });
  }
};
for (const type of ["pointerdown", "keydown", "wheel", "scroll"] as const) {
  window.addEventListener(type, interaction, { passive: true, capture: true });
}

// ── the MAIN-world probe's answers: instrumentation, tools, tool results ─────
let aiuiPage = false;
window.addEventListener("message", (event) => {
  if (event.source !== window) {
    return;
  }
  const data = event.data as {
    aiuiInstrumented?: boolean;
    aiuiTools?: Array<{
      ns: string;
      tools: Array<{ name: string; description: string; inputSchema?: Record<string, unknown> }>;
    }>;
    aiuiToolsResult?: { callId: string; ok: boolean; value?: unknown; error?: string };
  };
  if (data?.aiuiInstrumented) {
    aiuiPage = true;
    sayHello(); // the probe may land after our first hello — correct the record
  }
  if (data?.aiuiTools !== undefined) {
    report({ kind: "tools", registrations: data.aiuiTools });
  }
  if (data?.aiuiToolsResult !== undefined) {
    report({ kind: "toolsResult", ...data.aiuiToolsResult });
  }
});

const sayHello = (): void => {
  report({
    kind: "hello",
    url: location.href,
    title: document.title,
    visible: document.visibilityState === "visible",
    focused: document.hasFocus(),
    aiui: aiuiPage,
  });
  checkForeign();
};

// ── the capability surface (the same command set the CDP page serves) ────────
serveRelay(PAGE_ADDRESS, {
  ring: (payload) => {
    const p = payload as {
      on?: boolean;
      turnTone?: boolean;
      hollow?: boolean;
      hint?: string;
    } | null;
    assertRing(
      p?.on === true,
      p?.turnTone === true,
      p?.hollow === true,
      typeof p?.hint === "string" ? p.hint : "",
    );
    return { ok: true };
  },
  flash: (payload) => {
    flash(String((payload as { kind?: string } | null)?.kind ?? "shot"));
    return { ok: true };
  },
  keylayer: (payload) => {
    setKeyCapture((payload as { capture?: boolean } | null)?.capture === true);
    return { ok: true };
  },
  selection: () => {
    const snap = watcher.snapshot();
    return snap === undefined
      ? null
      : {
          text: snap.text,
          ...(snap.sourceLoc !== undefined ? { sourceLoc: snap.sourceLoc } : {}),
          ...(snap.cell !== undefined ? { cell: snap.cell } : {}),
          ...(snap.cellLoc !== undefined ? { cellLoc: snap.cellLoc } : {}),
          ...(snap.tex !== undefined ? { tex: snap.tex } : {}),
          ...(snap.url !== "" ? { url: snap.url } : {}),
          title: document.title,
        };
  },
  viewport: () => ({
    w: window.innerWidth,
    h: window.innerHeight,
    dpr: window.devicePixelRatio || 1,
  }),
  ink: (payload) => {
    const p = (payload ?? {}) as { on?: boolean; fadeSec?: number; clear?: boolean };
    if (p.clear === true) {
      ink?.clear();
      return { ok: true };
    }
    if (p.on === true) {
      ink ??= mountInk((points) => report({ kind: "stroke", points }));
      ink.setOn(true, p.fadeSec ?? 0);
      return { ok: true };
    }
    ink?.setOn(false, p.fadeSec ?? 0);
    return { ok: true };
  },
  region: (payload) => {
    if ((payload as { arm?: boolean } | null)?.arm === true) {
      armRegion();
    } else {
      disarmRegion();
    }
    return { ok: true };
  },
  pencil: (payload) => {
    // The pencil surface runs in THIS isolated world (it only needs the DOM, no
    // page globals) — like ink, unlike jump. `{op, …}` mirrors the CDP tier.
    const p = (payload ?? {}) as Record<string, unknown>;
    const op = String(p.op ?? "");
    if (op === "engage") {
      pencil ??= mountPencil();
      pencil.engage(Number(p.fadeSec ?? 0));
      return { ok: true };
    }
    if (pencil === undefined) {
      return { ok: true };
    }
    switch (op) {
      case "disengage":
        pencil.disengage();
        pencil = undefined;
        return { ok: true };
      case "fade":
        pencil.setFade(Number(p.fadeSec ?? 0));
        return { ok: true };
      case "clear":
        pencil.clear();
        return { ok: true };
      case "undo":
        pencil.undo();
        return { ok: true };
      case "size":
        return pencil.size();
      case "rbegin":
        pencil.remoteBegin(String(p.id), p.init as never);
        return { ok: true };
      case "rpoint":
        pencil.remotePoint(String(p.id), p.point as never);
        return { ok: true };
      case "rend":
        pencil.remoteEnd(String(p.id), p.point as never);
        return { ok: true };
      case "rcancel":
        pencil.remoteCancel(String(p.id));
        return { ok: true };
      default:
        return { error: `unknown pencil op: ${op}` };
    }
  },
  toolsCall: (payload) => {
    // Forward into the MAIN world (the registry lives there); the result
    // comes back as a message → a `toolsResult` report, correlated by callId.
    window.postMessage({ aiuiToolsCall: payload }, "*");
    return { ok: true };
  },
  jump: (payload) => {
    // Jump-to-editor runs in the MAIN world too: the picker needs
    // `__AIUI__.sourceRoot` and `__aiuiCells`, invisible from this isolated
    // world. content-main.ts hosts it (see jump-mode.ts).
    window.postMessage(
      { aiuiJump: { arm: (payload as { arm?: boolean } | null)?.arm === true } },
      "*",
    );
    return { ok: true };
  },
  locate: () => null, // instrumented-page jump: anticipated, post-parity
});

// The boot hello: a fresh document knows nothing, and the panel may hold state
// for this tab (ring, key layer, ink mode). Saying hello is what re-arms it —
// the bus replays on every hello (the reload lesson, learned in Phase 3).
sayHello();
document.addEventListener("visibilitychange", sayHello);
