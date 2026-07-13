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
 *    **broadcastRing** → the same call on every attached page. The heavy ink
 *    surface is evaluated INTO the page first (`ensureInk`) — the page never
 *    fetches anything, because an https page cannot import from the channel's
 *    http origin.
 *  - **SurfaceTargeting** → the tab you are LOOKING at (visibility, not focus —
 *    see `relead`): looking at the panel must not blank the target.
 *  - **CaptureSource** → `Page.captureScreenshot`: stills with NO grant and no
 *    MediaStream. `holdStream` is therefore a bookkeeping handle — there is
 *    nothing to warm, which is this tier's quiet advantage over MV3.
 *
 * Two things the seam does not say, and this bus must:
 *  - **The panel is not a target.** Its own page (and devtools/chrome pages) are
 *    excluded from the registry, so the client never inks, rings, or keylayers
 *    itself — and focusing the panel leaves the leader tab standing.
 *  - **A reload is a new document.** Page-level assertions (ring, keylayer, ink
 *    mode) live in that document and die with it, while the client's *desire* is
 *    unchanged — so no claim re-applies. The bus therefore remembers what it
 *    asserted per tab and replays it when a document re-announces itself. Ink
 *    STROKES are not replayed: they were the old document's.
 *
 * Security: the bus dials the channel's same-origin `/intent/cdp` bridge, never
 * the browser's debug port (Chrome rejects that from a page, by design). The
 * bridge is loopback-only server-side; this guard is the client-side echo of it.
 */

import type {
  CaptureSource,
  HeldStream,
  IntentHost,
  PageCapability,
  PageEvent,
  PageTransport,
  PanelShot,
  RingState,
  SurfaceTargeting,
} from "../transport";
import { buildPageScript, PAGE_REPORT_BINDING, type PageReport } from "./page-script";
import { type CdpSocket, connectCdp } from "./protocol";

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
  /** Whether THIS document already carries the ink bundle (see `ensureInk`). */
  inkInjected: boolean;
}

export interface CdpBusOptions {
  /** The bridge URL (same-origin `/intent/cdp`); must be loopback. */
  cdpUrl: string;
  /** The channel origin: where the panel reads the ink bundle, and which pages
   * are the panel's own (never driven). */
  channelOrigin: string;
  /** Socket factory (tests script the far end); defaults to `WebSocket`. */
  socketFactory?: (url: string) => CdpSocket;
  /** The ink bundle's source (tests override; defaults to the channel route). */
  inkSource?: () => Promise<string>;
  log?: (message: string) => void;
}

export interface CdpBus extends IntentHost {
  /** The attached, non-excluded pages — introspection for tests and the panel. */
  pages(): AttachedPage[];
  dispose(): void;
}

const LOOPBACK = /^wss?:\/\/(127\.0\.0\.1|\[::1\]|localhost)(:\d+)?(\/|$)/;

/** Capabilities whose effect lives in the DOCUMENT — replay them on reload. */
const STICKY: ReadonlySet<PageCapability> = new Set(["keylayer", "ink"]);

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
  /** The ink bundle, read ONCE from our own origin and re-used for every page. */
  const inkSource =
    options.inkSource ??
    (() =>
      fetch(`${options.channelOrigin}/intent/page-ink.js`).then((res) => {
        if (!res.ok) {
          throw new Error(`the channel could not bundle the ink surface (${res.status})`);
        }
        return res.text();
      }));
  let inkBundle: Promise<string> | undefined;

  const bySession = new Map<string, AttachedPage>();
  const byTarget = new Map<string, AttachedPage>();
  const byTab = new Map<number, AttachedPage>();
  const pageHandlers = new Set<(event: PageEvent) => void>();
  const tabHandlers = new Set<(tab: number | undefined) => void>();
  /** What we asserted per tab, so a fresh document gets it back. */
  const sticky = new Map<number, Map<PageCapability, unknown>>();
  let ring: RingState = { on: false, turnTone: false };
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
  const excluded = (url: string): boolean =>
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
   * The leader tab: the last page the user actually LOOKED at — the old
   * client's `lastActiveTab`, which it got from `chrome.tabs.query({active:
   * true})`. The CDP equivalent is VISIBILITY, not focus: `document.hasFocus()`
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

  const evaluate = (sessionId: string, expression: string, awaitPromise = false) =>
    cdp.send(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise },
      sessionId,
    ) as Promise<{ result?: { value?: unknown } }>;

  /** The capability call, as an expression evaluated in the page's own world. */
  const invoke = (capability: PageCapability | "ring", payload?: unknown): string =>
    `window.__aiuiIntentPage && window.__aiuiIntentPage.handle(${JSON.stringify(capability)}, ${JSON.stringify(payload ?? null)})`;

  /**
   * The ink surface, evaluated INTO the page (once per document). The page
   * cannot fetch it: on an https page a module from the channel's http origin
   * is mixed content, so the panel reads the bundle from its own origin and
   * hands over the source. Any page can be inked; that is the point.
   */
  const ensureInk = async (page: AttachedPage): Promise<void> => {
    if (page.inkInjected) {
      return;
    }
    inkBundle ??= inkSource();
    await evaluate(page.sessionId, await inkBundle);
    page.inkInjected = true;
  };

  /** Deliver one capability to one page — the single path everything takes. */
  const apply = async (
    page: AttachedPage,
    capability: PageCapability | "ring",
    payload?: unknown,
  ): Promise<unknown> => {
    if (capability === "ink") {
      await ensureInk(page);
    }
    const result = await evaluate(page.sessionId, invoke(capability, payload));
    return result.result?.value;
  };

  /** A document just announced itself: give it back what we had asserted. */
  const replay = (page: AttachedPage): void => {
    if (ring.on) {
      void apply(page, "ring", ring).catch(() => {});
    }
    for (const [capability, payload] of sticky.get(page.tab) ?? []) {
      void apply(page, capability, payload).catch(() => {});
    }
  };

  const onReport = (sessionId: string, report: PageReport): void => {
    const page = bySession.get(sessionId);
    if (page === undefined) {
      return;
    }
    switch (report.kind) {
      case "hello": {
        const reloaded = page.url !== "" && page.url !== report.url;
        // A hello means a document that has just installed the bootstrap —
        // and a fresh document carries none of the ink bundle we evaluated
        // into the last one.
        page.inkInjected = false;
        page.url = report.url;
        page.title = report.title;
        page.visible = report.visible;
        page.focused = report.focused;
        page.aiui = report.aiui;
        emit({ kind: "aiuiSupport", tab: page.tab, supported: report.aiui });
        relead(page);
        // A fresh document (reload or full navigation) lost everything the
        // client had asserted — and the client's desire never changed, so no
        // claim will re-apply. The bus does it.
        replay(page);
        if (reloaded) {
          log(`page ${page.tab} loaded ${report.url}`);
        }
        break;
      }
      case "focus":
        page.visible = report.visible;
        page.focused = report.focused;
        relead(page);
        break;
      case "selection":
        emit({ kind: "selectionPresent", tab: page.tab, present: report.present });
        break;
      case "interaction":
        emit({ kind: "interaction", tab: page.tab });
        break;
      case "navigation":
        emit({
          kind: "navigation",
          tab: page.tab,
          from: report.from,
          to: report.to,
          navKind: report.navKind,
        });
        page.url = report.to;
        break;
      case "key":
        emit({
          kind: "keyForward",
          tab: page.tab,
          key: report.key,
          phase: report.phase,
          repeat: report.repeat,
        });
        break;
      case "stroke":
        break; // stroke counts enrich the shot payload later (post-v1)
    }
  };

  /** Everything one page session needs, in order (the binding BEFORE the code
   * that calls it, so the bootstrap's hello lands). `Page.enable` is not
   * decoration: without it there are no navigation events, and a page that
   * reloads comes back bare — a live turn on a reloaded tab was silently
   * deaf (found live, Phase 3; the re-injection below is the other half). */
  const prepare = async (sessionId: string): Promise<void> => {
    await cdp.send("Runtime.enable", {}, sessionId);
    await cdp.send("Page.enable", {}, sessionId);
    await cdp.send("Runtime.addBinding", { name: PAGE_REPORT_BINDING }, sessionId);
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: script }, sessionId);
    await evaluate(sessionId, script); // the document already loaded
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
        log(`ignoring ${info.url} (a panel page, or browser chrome)`);
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
      const page: AttachedPage = {
        sessionId,
        targetId: info.targetId,
        tab: nextTab++,
        url: "",
        title: info.title ?? "",
        visible: false,
        focused: false,
        aiui: false,
        inkInjected: false,
      };
      bySession.set(sessionId, page);
      byTarget.set(page.targetId, page);
      byTab.set(page.tab, page);
      if (activeTab === undefined) {
        setActive(page.tab); // something must be the target before any focus report
      }
      void prepare(sessionId).catch((err: unknown) => {
        log(
          `could not instrument ${info.url}: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
      log(`attached tab ${page.tab} → ${info.url}`);
      return;
    }
    if (event.method === "Target.detachedFromTarget") {
      const page = bySession.get(String(event.params.sessionId));
      if (page === undefined) {
        return;
      }
      bySession.delete(page.sessionId);
      byTarget.delete(page.targetId);
      byTab.delete(page.tab);
      sticky.delete(page.tab);
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
          void evaluate(page.sessionId, script).catch(() => {});
        }
      }
      return;
    }
    if (event.method === "Runtime.bindingCalled" && event.params.name === PAGE_REPORT_BINDING) {
      if (typeof event.sessionId !== "string") {
        return;
      }
      try {
        onReport(event.sessionId, JSON.parse(String(event.params.payload)) as PageReport);
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
      if (STICKY.has(capability)) {
        const perTab = sticky.get(tab) ?? new Map<PageCapability, unknown>();
        perTab.set(capability, payload);
        sticky.set(tab, perTab);
      }
      return apply(page, capability, payload);
    },
    broadcastRing: (state) => {
      ring = state;
      for (const page of byTab.values()) {
        void apply(page, "ring", state).catch(() => {});
      }
    },
    onPageEvent: (handler) => {
      pageHandlers.add(handler);
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
      const page = byTab.get(tab);
      return Promise.resolve(page && { url: page.url, title: page.title });
    },
  };

  const capture: CaptureSource = {
    // `Page.captureScreenshot` asks nobody: any attached tab, no grant, no
    // MediaStream. So the shot/selection acts light up as soon as a turn is
    // open, and they follow the tab you are looking at.
    grantless: true,
    // Nothing to warm, either — the "held stream" is a handle the claim's
    // lifecycle can still hold.
    holdStream: (tab) => Promise.resolve<HeldStream>({ tab, release: () => {} }),
    grabShot: async (tab): Promise<PanelShot> => {
      const page = byTab.get(tab);
      if (page === undefined) {
        throw new Error(`no attached page for tab ${tab}`);
      }
      const shot = (await cdp.send(
        "Page.captureScreenshot",
        { format: "png", captureBeyondViewport: false },
        page.sessionId,
      )) as { data?: string };
      if (typeof shot.data !== "string") {
        throw new Error("Page.captureScreenshot returned no data");
      }
      const bytes = Uint8Array.from(atob(shot.data), (c) => c.charCodeAt(0));
      const metrics = (await cdp.send("Page.getLayoutMetrics", {}, page.sessionId)) as {
        cssVisualViewport?: { clientWidth?: number; clientHeight?: number };
      };
      return {
        width: Math.round(metrics.cssVisualViewport?.clientWidth ?? 0),
        height: Math.round(metrics.cssVisualViewport?.clientHeight ?? 0),
        mime: "image/png",
        bytes,
        thumb: `data:image/png;base64,${shot.data}`,
      };
    },
  };

  return {
    transport,
    targeting,
    capture,
    pages: () => [...byTab.values()],
    dispose: () => cdp.close(),
  };
}
