/**
 * content.ts — the extension's entire in-page footprint (the CDP tier's
 * `page-script.ts`, wearing the other transport).
 *
 * The page carries ONLY what should be capturable — the ring, the pencil, the
 * feedback flashes. No pill, no badge, no hints: every control lives in the
 * panel. Modes are the PANEL's state; this script obeys capability commands and
 * reports facts back. It speaks the same `PageReport` union the injected CDP
 * bootstrap speaks, so both hosts map page facts with one vocabulary.
 *
 * Being a real module (Vite bundles it) buys what the CDP bootstrap could not
 * have: it *imports* the pencil surface (`../page/pencil-mount`) instead of
 * having a bundle evaluated into it, and it imports the runtime's selection watcher, so
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
 * The ring, flash, region, and pencil surfaces are the SHARED page surfaces
 * (`../page/surfaces`): one implementation this script imports directly and the
 * CDP bootstrap stringifies in — same ids, same look, one rule.
 */

import { pageTabRecord } from "@habemus-papadum/aiui-intent-runtime/instrumentation";
import { locateComponents } from "@habemus-papadum/aiui-intent-runtime/locator";
import { installSelectionWatcher } from "@habemus-papadum/aiui-intent-runtime/selection";
import { mountPencil } from "../cdp/page-bundle";
import type { PageReport } from "../cdp/page-script";
import { createDriverWatch } from "../page/driver-watch";
import {
  createFlash,
  createPencilOps,
  createRegionSurface,
  createRingSurface,
} from "../page/surfaces";
import { DRIVER_TIMEOUT_MS } from "../transport";
import { PAGE_ADDRESS, type ReportMessage } from "./protocol";
import { serveRelay } from "./relay";

/** Set once this script learns it is an ORPHAN (the extension was reloaded
 * under it — ext:watch does that on every rebuild). Reports stand down; the
 * new content script, injected on the next tab reload, owns the page. */
let orphaned = false;

const report = (r: PageReport): void => {
  if (orphaned) {
    return;
  }
  const message: ReportMessage = { aiuiIntentReport: 1, report: r };
  try {
    chrome.runtime.sendMessage(message).catch(() => {
      // No panel open: facts are re-reported on the next hello, so a dropped
      // one is never load-bearing.
    });
  } catch {
    // "Extension context invalidated" — sendMessage THROWS (synchronously,
    // so the .catch above never applies; found live on visibilitychange →
    // sayHello after an ext:watch reload). It means no driver can EVER
    // reach this script again: the driver-gone verdict, delivered sync.
    // Hard-clean like the watchdog would and go quiet.
    orphaned = true;
    pencilOps({ op: "clear" });
    dropAssertions();
    driverWatch.dispose();
  }
};

// ── the ring + the flash wash: the shared page surfaces (../page/surfaces) ───
// The ring's fourth state (HOLLOW — armed but this tab's pixels need a grant)
// matters most HERE: MV3's capture grant is per-tab, so every tab switch lands
// on an ungranted page. The hint text is whatever the host handed down (the
// live chrome.commands binding) — this script never knows what the key is.
const { assert: assertRing } = createRingSurface();
const flash = createFlash();

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
// Shared with the CDP bootstrap (../page/surfaces). The locator reads DOM
// attributes (data-source-loc stamps), which the isolated world sees fine; only
// window.__AIUI__ globals are main-world, so `locateComponents` imports cleanly.
const { arm: armRegion, disarm: disarmRegion } = createRegionSurface({
  report,
  locate: (rect) => locateComponents(rect),
});

// ── pencil: the markup surface, imported (no injection, no CSP fight) ────────
// The `{op, …}` dispatcher is the shared surface (../page/surfaces); the mount
// is imported here (always present — no bundle to wait for), so the factory's
// "not injected" guard never fires on this tier.
const pencilOps = createPencilOps(() => mountPencil);

// ── selection: structured, via the runtime's watcher ─────────────────────────
const watcher = installSelectionWatcher({
  onChange: (snap) => report({ kind: "selection", present: snap !== undefined }),
});

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
    aiuiJumpDone?: boolean;
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
  if (data?.aiuiJumpDone === true) {
    // The MAIN world's jump pick finished (commit / click-away / Esc): relay the
    // completion so the panel auto-exits jump mode (owner, 2026-07-16).
    report({ kind: "jumpDone" });
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
};

// ── driver liveness: self-cleanup when the panel dies mid-assertion ──────────
// Every assertion handler below notes proof-of-life; the panel additionally
// beats `heartbeat` with its per-boot session id. Beats stop (panel closed
// mid-turn, extension reloaded under ext:watch — THIS script is then an
// orphan) → hard cleanup. New session id → soft reset; the reloaded panel's
// claims re-assert what they want (see page/driver-watch.ts for the rules).
const dropAssertions = (): void => {
  setKeyCapture(false);
  assertRing(false, false, false, "");
  disarmRegion();
  // Disengage only — the handle (and its strokes) survives a soft reset, so a
  // reloaded panel's turn recovery finds its markup (the `adopt` rule; the
  // dispatcher owns the handle now, matching the CDP tier).
  pencilOps({ op: "disengage" });
};
/** The last driver (panel-boot) session that beat us — see heartbeat below. */
let lastDriverSession: string | undefined;
const driverWatch = createDriverWatch({
  timeoutMs: DRIVER_TIMEOUT_MS,
  onGone: () => {
    // Hard: the strokes belong to a DEAD session — nobody can clear them later.
    console.info("[aiui-intent] watchdog verdict: driver silent — hard clean (backup)");
    document.documentElement.dataset.aiuiIntentVerdict = `watchdog@${new Date().toISOString()}`;
    pencilOps({ op: "clear" });
    dropAssertions();
  },
  // Soft: strokes survive (the `adopt` rule — a reloaded panel's turn
  // recovery must find its markup); assertions drop and get re-asserted.
  onChanged: dropAssertions,
});

// ── the capability surface (the same command set the CDP page serves) ────────
serveRelay(PAGE_ADDRESS, {
  heartbeat: (payload) => {
    const session = String((payload as { session?: string } | null)?.session ?? "");
    // A session id this script has not seen means a NEW panel boot — one that
    // never heard our load-time hello (the panel opened after this page
    // loaded, or reloaded since). Re-announce the page facts so its pills
    // (aiui, selection) light without a manual page refresh.
    if (session !== "" && session !== lastDriverSession) {
      // Page-console breadcrumb for the pill-lighting flow (issue seen live
      // 2026-07-18): pairs with the panel console's "[ext] hello ←" line.
      console.info(
        `[aiui-intent] new driver session ${session} — re-announcing (aiui=${aiuiPage})`,
      );
      lastDriverSession = session;
      sayHello();
    }
    driverWatch.alive(session);
    return { ok: true };
  },
  /** The WORKER's affirmative panel-close verdict (sw.ts, owner 2026-07-17):
   * the same hard clean the silence watchdog reaches, delivered seconds
   * sooner. The watchdog timer is quieted (nothing left to convict) and
   * re-arms on the next driver's first beat. */
  driverGone: () => {
    // Which verdict fired is a live debugging question (SW port vs silence
    // watchdog). The console line is for a human DevTools; the dataset stamp
    // is for tooling — isolated-world console output is invisible to a CDP
    // reader, but the DOM is shared.
    console.info("[aiui-intent] worker verdict: panel closed — hard clean (port)");
    document.documentElement.dataset.aiuiIntentVerdict = `worker-port@${new Date().toISOString()}`;
    pencilOps({ op: "clear" });
    dropAssertions();
    driverWatch.dispose();
    return { ok: true };
  },
  ring: (payload) => {
    driverWatch.alive();
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
    driverWatch.alive();
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
          // The canonical tab record (shared builder; isolated world → aiui
          // detection via the DOM footprint, sourceRoot absent by design).
          tab: pageTabRecord(),
        };
  },
  viewport: () => ({
    w: window.innerWidth,
    h: window.innerHeight,
    dpr: window.devicePixelRatio || 1,
  }),
  region: (payload) => {
    driverWatch.alive();
    if ((payload as { arm?: boolean } | null)?.arm === true) {
      armRegion();
    } else {
      disarmRegion();
    }
    return { ok: true };
  },
  pencil: (payload) => {
    driverWatch.alive();
    // The pencil surface runs in THIS isolated world (it only needs the DOM, no
    // page globals) — unlike jump. The `{op, …}` dispatch is the shared surface.
    return pencilOps((payload ?? {}) as Record<string, unknown>);
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
});

// The boot hello: a fresh document knows nothing, and the panel may hold state
// for this tab (ring, key layer, pencil mode). Saying hello is what re-arms it —
// the bus replays on every hello (the reload lesson, learned in Phase 3).
sayHello();
document.addEventListener("visibilitychange", sayHello);
