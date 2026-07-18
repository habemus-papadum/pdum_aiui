/**
 * cdp-bus.ts — the CdpBus: an `IntentHost` over the session browser's CDP,
 * driving REAL tabs, extension-free (intent-client plan, Phase 3). It fulfills
 * the same seam the FakeBus does — PageTransport / SurfaceTargeting /
 * CaptureSource — so the client core is byte-for-byte identical across tiers.
 *
 * How each seam maps onto CDP:
 *  - **auto-attach + per-document injection** (the installCaptureMarker
 *    pattern): `Target.setAutoAttach` in flat mode, plus an explicit attach for
 *    the tabs already open. Every page session gets `Runtime.enable` +
 *    `Runtime.addBinding` (the page→panel channel) + the bootstrap, both as
 *    `addScriptToEvaluateOnNewDocument` (future documents) and as one catch-up
 *    `Runtime.evaluate` (the document already loaded).
 *  - **PageTransport.requestPage** → `Runtime.evaluate` of
 *    `__aiuiIntentPage.handle(cap, payload)` in that page's world;
 *    **broadcastRing** → the same call on every attached page. The heavy page
 *    bundle is evaluated INTO the page first (page-rpc.ts's `ensureBundle`) —
 *    the page never fetches anything, because an https page cannot import from
 *    the channel's http origin.
 *  - **SurfaceTargeting** → the tab you are LOOKING at (visibility, not focus —
 *    see `relead`): looking at the panel must not blank the target.
 *  - **CaptureSource** → `Page.captureScreenshot`: stills with NO grant and no
 *    MediaStream. `holdStream` is therefore a bookkeeping handle — there is
 *    nothing to warm, which is this tier's quiet advantage over MV3.
 *
 * Two things the seam does not say, and this bus must:
 *  - **The panel is not a target.** Its own page (and devtools/chrome pages) are
 *    excluded from the registry, so the client never pencils, rings, or
 *    keylayers itself — and focusing the panel leaves the leader tab standing.
 *  - **A reload is a new document.** Page-level assertions (ring, keylayer,
 *    pencil mode) live in that document and die with it, while the client's
 *    *desire* is unchanged — so no claim re-applies. The bus therefore remembers
 *    what it asserted per tab and replays it when a document re-announces
 *    itself. Pencil STROKES are not replayed: they were the old document's.
 *
 * This file is the composition root: the CDP event dispatcher, the page
 * registry + leader election, and the host facades. The seams it composes live
 * in siblings — page-rpc.ts (evaluate/apply/prepare + the sticky/ring replay
 * state), cdp-reports.ts (PageReport → PageEvent mapping), cdp-capture.ts
 * (the screenshot CaptureSource) — all panel-side only.
 *
 * Security: the bus dials the channel's same-origin `/intent/cdp` bridge, never
 * the browser's debug port (Chrome rejects that from a page, by design). The
 * bridge is loopback-only server-side; this guard is the client-side echo of it.
 */

import { PAGE_REPORT_BINDING, type PageReport } from "../page/report";
import {
  HEARTBEAT_MS,
  type IntentHost,
  type PageCapability,
  type PageCapabilityMap,
  type PageEvent,
  type PageTransport,
  ringForTab,
  type SurfaceTargeting,
} from "../transport";
import { createCdpCapture } from "./cdp-capture";
import { handleReport } from "./cdp-reports";
import { createPageRpc } from "./page-rpc";
import { buildPageScript } from "./page-script";
import { type CdpSocket, connectCdp } from "./protocol";
import { createScreencast, type Screencast } from "./screencast";

/** One attached page target and the facts it has reported. */
export interface AttachedPage {
  sessionId: string;
  targetId: string;
  tab: number;
  url: string;
  title: string;
  visible: boolean;
  focused: boolean;
  aiui: boolean;
  /** The page's latest selection-present verdict (replayed to late subscribers). */
  selectionPresent: boolean;
  /** Whether THIS document already carries the page bundle (see page-rpc.ts's
   * `ensureBundle`). */
  bundleInjected: boolean;
}

export interface CdpBusOptions {
  /** The bridge URL (same-origin `/intent/cdp`); must be loopback. */
  cdpUrl: string;
  /** The channel origin: where the panel reads the page bundle, and which pages
   * are the panel's own (never driven). */
  channelOrigin: string;
  /** The origin THIS bus's document is served from (default: `location.origin`).
   * Everything on it is excluded from targeting — see `excluded` below. */
  selfOrigin?: string;
  /** Socket factory (tests script the far end); defaults to `WebSocket`. */
  socketFactory?: (url: string) => CdpSocket;
  /** The page bundle's source (tests override; defaults to the channel route). */
  bundleSource?: () => Promise<string>;
  log?: (message: string) => void;
}

export interface CdpBus extends IntentHost {
  /** The attached, non-excluded pages — introspection for tests and the panel. */
  pages(): AttachedPage[];
  /** A live MediaStream of the leader tab (screencast → canvas), for the remote
   * pencil host. The MV3 tier has a real tabCapture stream instead; the CDP tier
   * has to synthesize one (see cdp/screencast.ts). `onReady` fires when the
   * stream first materializes (wire it to the pencil host's refresh). */
  screencast(options?: { onReady?: () => void }): Screencast;
  dispose(): void;
}

const LOOPBACK = /^wss?:\/\/(127\.0\.0\.1|\[::1\]|localhost)(:\d+)?(\/|$)/;

export async function connectCdpBus(options: CdpBusOptions): Promise<CdpBus> {
  if (!LOOPBACK.test(options.cdpUrl)) {
    throw new Error(
      `the CdpBus refuses a non-loopback bridge (${options.cdpUrl}) — CDP is root of the ` +
        "browser and stays a this-machine-only dev affordance (docs/guide/chrome.md)",
    );
  }
  const log = options.log ?? (() => {});
  const cdp = await connectCdp(options.cdpUrl, options.socketFactory);
  const script = buildPageScript();
  // The page-side delivery machinery (evaluate/apply/prepare) and the state it
  // replays on reload (sticky assertions + the ring desire) live in page-rpc.ts.
  const rpc = createPageRpc({
    cdp,
    script,
    channelOrigin: options.channelOrigin,
    ...(options.bundleSource ? { bundleSource: options.bundleSource } : {}),
  });

  const bySession = new Map<string, AttachedPage>();
  const byTarget = new Map<string, AttachedPage>();
  const byTab = new Map<number, AttachedPage>();
  const pageHandlers = new Set<(event: PageEvent) => void>();
  const tabHandlers = new Set<(tab: number | undefined) => void>();
  let nextTab = 1;
  let activeTab: number | undefined;
  /** The page with keyboard focus, when the browser app itself has it. */
  let focusedTab: number | undefined;
  /** The page most recently seen (visible in its window) — the fallback. */
  let visibleTab: number | undefined;

  /** The panel itself, devtools, and browser pages are never targets. Any
   * local `/intent/` page counts, not just our own origin: a second panel on
   * another channel is still a panel, and a client that inks one is absurd. */
  const PANEL_PAGE = /^https?:\/\/(127\.0\.0\.1|\[::1\]|localhost)(:\d+)?\/intent(\/|$)/;
  /** …and so is the panel's OWN origin, wholesale. The `/intent/` pattern
   * recognizes the channel-served panel, but the DEV-served panel lives at
   * the ROOT path (`localhost:<vite>/?channel=…`) — no URL shape says
   * "panel" there. The bus doesn't have to guess: it RUNS in the panel's
   * document, so everything on `location.origin` is its own furniture, not
   * a markup target (found live: the panel armed, then ringed, penciled and
   * keylayered ITSELF, and the strokes had no un-draw short of ending the
   * turn). For the channel-served panel this widens to the whole channel origin
   * — pencil/console pages — which are aiui furniture too. Self-driving is an
   * explicit non-goal (owner, 2026-07-15). */
  const selfOrigin =
    options.selfOrigin ?? (typeof location !== "undefined" ? location.origin : undefined);
  const excluded = (url: string): boolean =>
    (selfOrigin !== undefined && (url === selfOrigin || url.startsWith(`${selfOrigin}/`))) ||
    url.startsWith(`${options.channelOrigin}/intent`) ||
    PANEL_PAGE.test(url) ||
    url.startsWith("devtools://") ||
    url.startsWith("chrome://") ||
    url.startsWith("chrome-extension://");

  const emit = (event: PageEvent): void => {
    for (const handler of pageHandlers) {
      handler(event);
    }
  };

  /**
   * The leader tab: the last page the user actually LOOKED at — the rule the
   * retired extension client's `lastActiveTab` derived from
   * `chrome.tabs.query({active: true})`. The CDP equivalent is VISIBILITY, not
   * focus: `document.hasFocus()`
   * is false for every page whenever the browser app isn't frontmost (you are
   * typing in your editor; an agent is driving the browser), so a focus-only
   * rule leaves the leader stuck wherever it first landed — found live, with
   * the turn pointed at an `about:blank` nobody had ever looked at.
   * `visibilityState` is true for the active tab of each window regardless.
   *
   * Never blanked by looking at the panel (the panel is not a page we drive) —
   * only by the leader itself going away.
   */
  const setActive = (tab: number | undefined): void => {
    if (tab === activeTab) {
      return;
    }
    activeTab = tab;
    for (const handler of tabHandlers) {
      handler(tab);
    }
  };

  /** Fold the two signals into the leader. Focus wins when the browser has it
   * (several windows can each show a visible tab; only one can hold focus);
   * otherwise the tab you last brought up leads. */
  const relead = (page: AttachedPage): void => {
    if (page.focused && page.visible) {
      focusedTab = page.tab;
    } else if (focusedTab === page.tab) {
      focusedTab = undefined; // it blurred (you moved to the panel) — but see below
    }
    if (page.visible) {
      visibleTab = page.tab;
    }
    setActive(focusedTab ?? visibleTab);
  };

  /**
   * Auto-attached but not (yet) driveable: a tab BORN as browser chrome — the
   * + button's chrome://newtab — parks here with its live session, and
   * `Target.targetInfoChanged` adopts it the moment it navigates somewhere
   * real. Found live (2026-07-16): the adoption verdict was rendered once,
   * against the URL the tab was born with, so a fresh tab navigated to the
   * app was never instrumented. targetId → sessionId.
   */
  const parked = new Map<string, string>();

  /** Take one auto-attached page in as a driven tab and instrument it. */
  const adoptPage = (
    sessionId: string,
    info: { targetId: string; url?: string; title?: string },
  ): void => {
    const page: AttachedPage = {
      sessionId,
      targetId: info.targetId,
      tab: nextTab++,
      url: "",
      title: info.title ?? "",
      visible: false,
      focused: false,
      aiui: false,
      selectionPresent: false,
      bundleInjected: false,
    };
    bySession.set(sessionId, page);
    byTarget.set(page.targetId, page);
    byTab.set(page.tab, page);
    if (activeTab === undefined) {
      setActive(page.tab); // something must be the target before any focus report
    }
    void rpc.prepare(sessionId).catch((err: unknown) => {
      log(`could not instrument ${info.url}: ${err instanceof Error ? err.message : String(err)}`);
    });
    log(`attached tab ${page.tab} → ${info.url}`);
  };

  cdp.onEvent((event) => {
    if (event.method === "Target.attachedToTarget") {
      const sessionId = String(event.params.sessionId);
      const info = event.params.targetInfo as {
        type?: string;
        targetId?: string;
        url?: string;
        title?: string;
      };
      if (info?.type !== "page" || typeof info.targetId !== "string") {
        return;
      }
      if (excluded(info.url ?? "")) {
        // Not detached — PARKED: browser chrome may become a real page (the
        // + button's fresh tab navigating to the app), and the kept session
        // is what lets targetInfoChanged adopt it without a re-attach.
        parked.set(info.targetId, sessionId);
        log(`parking ${info.url} (panel page or browser chrome — adopted if it navigates)`);
        return;
      }
      if (byTarget.has(info.targetId)) {
        // Browser-level auto-attach ALREADY takes the targets that were open,
        // and then our explicit adoption pass attaches them again — one page,
        // two sessions, and (before this) two tabs. Keep the first session and
        // hand the duplicate back; the page must be instrumented exactly once,
        // or the second `addBinding` steals the reports from the first.
        void cdp.send("Target.detachFromTarget", { sessionId }).catch(() => {});
        return;
      }
      adoptPage(sessionId, info as { targetId: string; url?: string; title?: string });
      return;
    }
    if (event.method === "Target.targetInfoChanged") {
      // A parked tab navigated: reconsider the verdict its birth URL got.
      const info = event.params.targetInfo as {
        type?: string;
        targetId?: string;
        url?: string;
        title?: string;
      };
      if (info?.type !== "page" || typeof info.targetId !== "string") {
        return;
      }
      const sessionId = parked.get(info.targetId);
      if (sessionId !== undefined && !excluded(info.url ?? "") && !byTarget.has(info.targetId)) {
        parked.delete(info.targetId);
        adoptPage(sessionId, info as { targetId: string; url?: string; title?: string });
      }
      return;
    }
    if (event.method === "Target.detachedFromTarget") {
      const gone = String(event.params.sessionId);
      for (const [targetId, parkedSession] of parked) {
        if (parkedSession === gone) {
          parked.delete(targetId); // a parked tab closed without ever navigating
        }
      }
      const page = bySession.get(gone);
      if (page === undefined) {
        return;
      }
      bySession.delete(page.sessionId);
      byTarget.delete(page.targetId);
      byTab.delete(page.tab);
      rpc.forgetTab(page.tab);
      if (focusedTab === page.tab) {
        focusedTab = undefined;
      }
      if (visibleTab === page.tab) {
        visibleTab = undefined;
      }
      if (activeTab === page.tab) {
        // The leader closed: hand the role to any page still standing.
        const next = byTab.keys().next();
        setActive(focusedTab ?? visibleTab ?? (next.done ? undefined : next.value));
      }
      return;
    }
    if (event.method === "Page.frameNavigated") {
      // A full navigation (reload, link, form) is a NEW document. The
      // add-script registration is supposed to cover it — but a page that came
      // back bare is a page the client cannot see, so re-evaluate the
      // bootstrap here too. It is idempotent by construction: the install
      // guard turns a second run into `adopt()` (re-hello, no double
      // listeners), and the hello is what re-arms ring/keys via `replay`.
      const frame = event.params.frame as { parentId?: string } | undefined;
      if (frame?.parentId === undefined && typeof event.sessionId === "string") {
        const page = bySession.get(event.sessionId);
        if (page !== undefined) {
          void rpc.reinject(page.sessionId).catch(() => {});
        }
      }
      return;
    }
    if (event.method === "Runtime.bindingCalled" && event.params.name === PAGE_REPORT_BINDING) {
      if (typeof event.sessionId !== "string") {
        return;
      }
      try {
        const report = JSON.parse(String(event.params.payload)) as PageReport;
        const page = bySession.get(event.sessionId);
        if (page !== undefined) {
          handleReport(page, report, { emit, relead, replay: rpc.replay, log });
        }
      } catch {
        // a malformed report never breaks the bus
      }
    }
  });

  await cdp.send("Target.setAutoAttach", {
    autoAttach: true,
    waitForDebuggerOnStart: false,
    flatten: true,
  });
  // Discovery is what makes `Target.targetInfoChanged` flow — auto-attach
  // alone does NOT subscribe to it (measured live, 2026-07-16: 0 events
  // without this call, on the very navigation the parked-tab adoption keys
  // on). Without it a + tab navigating to the app was never reconsidered.
  await cdp.send("Target.setDiscoverTargets", { discover: true });
  // Auto-attach only covers targets created from now on — adopt the open ones.
  const { targetInfos } = (await cdp.send("Target.getTargets")) as {
    targetInfos?: Array<{ type?: string; targetId?: string; url?: string }>;
  };
  for (const target of targetInfos ?? []) {
    if (
      target.type === "page" &&
      typeof target.targetId === "string" &&
      !excluded(target.url ?? "")
    ) {
      void cdp
        .send("Target.attachToTarget", { targetId: target.targetId, flatten: true })
        .catch(() => {});
    }
  }

  const transport: PageTransport = {
    requestPage: async (tab, capability, payload) => {
      const page = byTab.get(tab);
      if (page === undefined) {
        return undefined;
      }
      rpc.rememberSticky(tab, capability, payload);
      // CDP's evaluate returns `unknown`; the reply is asserted to the
      // capability's declared shape here — the one wire-boundary cast this
      // tier needs (a stale/foreign page could return anything).
      return rpc.apply(page, capability, payload) as Promise<
        PageCapabilityMap[PageCapability]["reply"] | undefined
      >;
    },
    broadcastRing: (state) => {
      rpc.setRing(state);
      // Projected per tab (ringForTab) for uniformity with the MV3 bus — this
      // host is grantless, so the client never sets `grant` and the projection
      // is the identity; the shared function is what KEEPS the two in step.
      for (const page of byTab.values()) {
        void rpc.apply(page, "ring", ringForTab(state, page.tab)).catch(() => {});
      }
    },
    onPageEvent: (handler) => {
      pageHandlers.add(handler);
      // Replay each attached page's cached facts to the late subscriber (the
      // client registers its handler several awaits after the bus attached
      // pages and their hellos arrived — same gap as the extension bus; the
      // twin fix, applied to both). Async, so the register-then-receive
      // contract holds.
      queueMicrotask(() => {
        if (!pageHandlers.has(handler)) {
          return;
        }
        for (const page of bySession.values()) {
          if (page.url !== "") {
            handler({ kind: "aiuiSupport", tab: page.tab, supported: page.aiui });
            handler({ kind: "selectionPresent", tab: page.tab, present: page.selectionPresent });
          }
        }
      });
      return () => pageHandlers.delete(handler);
    },
  };

  const targeting: SurfaceTargeting = {
    activeTab: () => activeTab,
    onActiveTabChange: (handler) => {
      tabHandlers.add(handler);
      return () => tabHandlers.delete(handler);
    },
    tabInfo: (tab) => {
      // This host's id namespace: the CDP target id and the driver handle.
      const page = byTab.get(tab);
      return Promise.resolve(
        page && { url: page.url, title: page.title, targetId: page.targetId, driverTab: tab },
      );
    },
  };

  // Stills off `Page.captureScreenshot` — no grant, no MediaStream (cdp-capture.ts).
  const capture = createCdpCapture({
    send: (method, params, sessionId) => cdp.send(method, params, sessionId),
    pageFor: (tab) => byTab.get(tab),
  });

  // ── driver liveness: beat every attached page (page/driver-watch.ts) ──────
  // Each page's watchdog arms on our assertions and hard-cleans them when the
  // beats stop — the panel tab closing mid-turn IS the beats stopping. The
  // session id is per panel BOOT, so a reloaded panel's first beat reads as a
  // driver CHANGE page-side (soft reset; strokes survive for turn recovery).
  const driverSession =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `drv-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const beatTimer = setInterval(() => {
    for (const tab of byTab.keys()) {
      void transport.requestPage(tab, "heartbeat", { session: driverSession }).catch(() => {});
    }
  }, HEARTBEAT_MS);

  return {
    transport,
    targeting,
    capture,
    pages: () => [...byTab.values()],
    screencast: (options) =>
      createScreencast({
        send: (method, params, sessionId) => cdp.send(method, params, sessionId),
        onEvent: cdp.onEvent,
        session: () => (activeTab !== undefined ? byTab.get(activeTab)?.sessionId : undefined),
        onActiveTabChange: targeting.onActiveTabChange,
        ...(options?.onReady ? { onReady: options.onReady } : {}),
      }),
    dispose: () => {
      clearInterval(beatTimer);
      cdp.close();
    },
  };
}
