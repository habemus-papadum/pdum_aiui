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
 *    bundle is evaluated INTO the page first (`ensureBundle`) — the page never
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

import {
  type CaptureSource,
  HEARTBEAT_MS,
  type HeldStream,
  type IntentHost,
  type PageCapability,
  type PageEvent,
  type PageTransport,
  type PanelShot,
  type RingState,
  ringForTab,
  type SurfaceTargeting,
} from "../transport";
import { buildPageScript, PAGE_REPORT_BINDING, type PageReport } from "./page-script";
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
  /** Whether THIS document already carries the page bundle (see `ensureBundle`). */
  bundleInjected: boolean;
}

export interface CdpBusOptions {
  /** The bridge URL (same-origin `/intent/cdp`); must be loopback. */
  cdpUrl: string;
  /** The channel origin: where the panel reads the ink bundle, and which pages
   * are the panel's own (never driven). */
  channelOrigin: string;
  /** The origin THIS bus's document is served from (default: `location.origin`).
   * Everything on it is excluded from targeting — see `excluded` below. */
  selfOrigin?: string;
  /** Socket factory (tests script the far end); defaults to `WebSocket`. */
  socketFactory?: (url: string) => CdpSocket;
  /** The ink bundle's source (tests override; defaults to the channel route). */
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

/** Capabilities whose effect lives in the DOCUMENT — replay them on reload. */
const STICKY: ReadonlySet<PageCapability> = new Set(["keylayer"]);

/** Width/height from a PNG's IHDR (8-byte signature, then a length+type header,
 * then two big-endian uint32s). Returns undefined if the bytes are not a PNG we
 * can read — the caller then falls back to its own estimate. */
function pngSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  // 8 sig + 4 length + 4 "IHDR" = 16, then width@16, height@20.
  if (bytes.length < 24 || bytes[0] !== 0x89 || bytes[1] !== 0x50) {
    return undefined;
  }
  const u32 = (o: number) =>
    ((bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3]) >>> 0;
  return { width: u32(16), height: u32(20) };
}

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
  /** The page bundle, read ONCE from our own origin and re-used for every page. */
  const bundleSource =
    options.bundleSource ??
    (() =>
      fetch(`${options.channelOrigin}/intent/page-bundle.js`).then((res) => {
        if (!res.ok) {
          throw new Error(`the channel could not build the page bundle (${res.status})`);
        }
        return res.text();
      }));
  let pageBundle: Promise<string> | undefined;

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
  /** …and so is the panel's OWN origin, wholesale. The `/intent/` pattern
   * recognizes the channel-served panel, but the DEV-served panel lives at
   * the ROOT path (`localhost:<vite>/?channel=…`) — no URL shape says
   * "panel" there. The bus doesn't have to guess: it RUNS in the panel's
   * document, so everything on `location.origin` is its own furniture, not
   * a markup target (found live: the panel armed, then ringed, inked and
   * keylayered ITSELF, and the ink had no un-ink short of ending the turn).
   * For the channel-served panel this widens to the whole channel origin —
   * paint/debug pages — which are aiui furniture too. Self-driving is an
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
   * The page bundle (locator · jump · pencil), evaluated INTO the page (once
   * per document). The page cannot fetch it: on an https page a module from
   * the channel's http origin is mixed content, so the panel reads the bundle
   * from its own origin and hands over the source. Any page can be marked up;
   * that is the point.
   */
  const ensureBundle = async (page: AttachedPage): Promise<void> => {
    if (page.bundleInjected) {
      return;
    }
    pageBundle ??= bundleSource();
    await evaluate(page.sessionId, await pageBundle);
    page.bundleInjected = true;
  };

  /** Deliver one capability to one page — the single path everything takes. */
  const apply = async (
    page: AttachedPage,
    capability: PageCapability | "ring",
    payload?: unknown,
  ): Promise<unknown> => {
    if (capability === "region" || capability === "jump" || capability === "pencil") {
      // The region drag's locator, the jump picker, and the pencil surface all
      // ride the evaluated bundle — deliver it before the op so instrumented
      // pages can name components / open the picker / draw.
      await ensureBundle(page);
    }
    const result = await evaluate(page.sessionId, invoke(capability, payload));
    return result.result?.value;
  };

  /** A document just announced itself: give it back what we had asserted. */
  const replay = (page: AttachedPage): void => {
    if (ring.on) {
      void apply(page, "ring", ringForTab(ring, page.tab)).catch(() => {});
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
        page.bundleInjected = false;
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
      case "foreign":
        emit({ kind: "foreignClient", tab: page.tab, armed: report.armed });
        break;
      case "tools":
        emit({ kind: "pageTools", tab: page.tab, registrations: report.registrations });
        break;
      case "toolsResult":
        emit({
          kind: "toolsResult",
          tab: page.tab,
          callId: report.callId,
          ok: report.ok,
          ...(report.value !== undefined ? { value: report.value } : {}),
          ...(report.error !== undefined ? { error: report.error } : {}),
        });
        break;
      case "region":
        emit({
          kind: "regionDrag",
          tab: page.tab,
          rect: report.rect,
          viewport: report.viewport,
          takenAt: report.takenAt,
          ...(report.components !== undefined ? { components: report.components } : {}),
        });
        break;
      case "jumpDone":
        emit({ kind: "jumpDone", tab: page.tab });
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
      bundleInjected: false,
    };
    bySession.set(sessionId, page);
    byTarget.set(page.targetId, page);
    byTab.set(page.tab, page);
    if (activeTab === undefined) {
      setActive(page.tab); // something must be the target before any focus report
    }
    void prepare(sessionId).catch((err: unknown) => {
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
      if (STICKY.has(capability)) {
        const perTab = sticky.get(tab) ?? new Map<PageCapability, unknown>();
        perTab.set(capability, payload);
        sticky.set(tab, perTab);
      }
      return apply(page, capability, payload);
    },
    broadcastRing: (state) => {
      ring = state;
      // Projected per tab (ringForTab) for uniformity with the MV3 bus — this
      // host is grantless, so the client never sets `grant` and the projection
      // is the identity; the shared function is what KEEPS the two in step.
      for (const page of byTab.values()) {
        void apply(page, "ring", ringForTab(state, page.tab)).catch(() => {});
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
    grabRegion: async (tab, rect): Promise<PanelShot> => {
      const page = byTab.get(tab);
      if (page === undefined) {
        throw new Error(`no attached page for tab ${tab}`);
      }
      // `Page.captureScreenshot`'s clip is NOT in the page's (zoomed) CSS pixels —
      // it is in UNZOOMED device-independent pixels, so under a non-100% browser
      // zoom it silently disagrees with the rubber band, which reports `clientX`/
      // `innerWidth` (both zoomed). The old "no scale math to get wrong" assumption
      // held only at zoom 1; at zoom Z the clip captured 1/Z of the region and put
      // it in the wrong place (found live at zoom 1.5 — the crop was the top-left
      // ⅔, offset). Multiply the rect by the live zoom to land the clip. `scale: 1`
      // then already yields full device resolution (clip · deviceScaleFactor, and
      // zoom · deviceScaleFactor === devicePixelRatio), so the pixels match a
      // full-frame `grabShot`. At zoom 1 this is a no-op.
      const metrics = (await cdp.send("Page.getLayoutMetrics", {}, page.sessionId)) as {
        cssVisualViewport?: { zoom?: number };
      };
      const zoom = metrics.cssVisualViewport?.zoom ?? 1;
      const shot = (await cdp.send(
        "Page.captureScreenshot",
        {
          format: "png",
          captureBeyondViewport: false,
          clip: {
            x: rect.x * zoom,
            y: rect.y * zoom,
            width: rect.w * zoom,
            height: rect.h * zoom,
            scale: 1,
          },
        },
        page.sessionId,
      )) as { data?: string };
      if (typeof shot.data !== "string") {
        throw new Error("Page.captureScreenshot returned no data");
      }
      const bytes = Uint8Array.from(atob(shot.data), (c) => c.charCodeAt(0));
      // Report the shot's true pixel size (from the PNG's IHDR), not the CSS rect —
      // the encoded image is device-resolution, so its dims are `rect · dpr`.
      const size = pngSize(bytes);
      return {
        width: size?.width ?? Math.round(rect.w),
        height: size?.height ?? Math.round(rect.h),
        mime: "image/png",
        bytes,
        thumb: `data:image/png;base64,${shot.data}`,
      };
    },
  };

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
