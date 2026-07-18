/**
 * extension-bus.ts — the `IntentHost` for the MV3 tier: the same three seams
 * (PageTransport / SurfaceTargeting / CaptureSource), served by the extension's
 * own plumbing. The client core is untouched; only the host changes.
 *
 * What the extension gives us that CDP could not:
 *
 *  - **Targeting is told, not inferred.** `chrome.tabs.query({active: true})`
 *    is the answer CDP made us reconstruct from visibility reports (and get
 *    wrong twice). The side panel is per-window, so this bus only ever cares
 *    about ITS window — a panel never drives a tab you cannot see from it.
 *  - **A real capture grant.** `tabCapture` is invocation-gated per tab: it
 *    works only on a tab the user invoked the extension on (toolbar click or
 *    the command chord). So `grantless` is FALSE here, the activation gesture's
 *    grant is a genuine world fact, and the capture acts stay dark until it
 *    exists. Same machine, same gates — the host supplies the fact.
 *  - **Continuous video.** The warm `tabCapture` MediaStream is a real video
 *    source; CDP screenshots are stills. This is why the extension still earns
 *    its keep now that the CdpBus drives real tabs.
 *
 * What it costs: the page is reached over `chrome.tabs.sendMessage`, which only
 * works where a content script is injected — so a tab the extension cannot
 * script (`chrome://`, the web store) simply has no page capabilities. The
 * transport answers `undefined` and the claims degrade, which is the same shape
 * as a tab that has gone away.
 */

import type { PageReport } from "../cdp/page-script";
import {
  type CaptureSource,
  HEARTBEAT_MS,
  type HeldStream,
  type IntentHost,
  type PageCapability,
  type PageCapabilityMap,
  type PageEvent,
  type PageTransport,
  type RingState,
  ringForTab,
  type SurfaceTargeting,
} from "../transport";
import { grabTabShot, holdTabStream, releaseTabStream } from "./capture";
import {
  ACTIVATE_COMMAND,
  BROKER_ADDRESS,
  isNavigationMessage,
  isReportMessage,
  PAGE_ADDRESS,
  PANEL_PORT_PREFIX,
  type StreamIdResult,
} from "./protocol";
import { relayRequest, relayRequestTab } from "./relay";

export interface ExtensionBusOptions {
  /** The window this side panel belongs to — the tabs it may drive. */
  windowId: number;
  log?: (message: string) => void;
}

export interface ExtensionBus extends IntentHost {
  /** The tab the panel is aimed at, for introspection. */
  activeTab(): number | undefined;
  dispose(): void;
}

export async function connectExtensionBus(options: ExtensionBusOptions): Promise<ExtensionBus> {
  const log = options.log ?? (() => {});
  const pageHandlers = new Set<(event: PageEvent) => void>();
  const tabHandlers = new Set<(tab: number | undefined) => void>();
  /** What we asserted per tab — a fresh document gets it back (see below). */
  const sticky = new Map<number, { keylayer?: unknown }>();
  /**
   * The latest PAGE FACTS per tab (hello's aiui verdict, selection presence),
   * replayed to late subscribers. The panel's client registers its page-event
   * handler several awaits after this bus connects, and a page's (re-)hello
   * can land in that gap — seen live 2026-07-18: the immediate first beat's
   * re-hello arrived before any subscriber existed, so the aiui pill stayed
   * unlit until a manual page reload. Facts are cached at RECEIPT and
   * replayed at SUBSCRIPTION, so the ordering can never matter again.
   */
  const pageFacts = new Map<number, { aiui?: boolean; selection?: boolean }>();
  const pageFactsFor = (tab: number): { aiui?: boolean; selection?: boolean } => {
    let facts = pageFacts.get(tab);
    if (facts === undefined) {
      facts = {};
      pageFacts.set(tab, facts);
    }
    return facts;
  };
  let ring: RingState = { on: false, turnTone: false };
  let activeTab: number | undefined;

  const emit = (event: PageEvent): void => {
    for (const handler of pageHandlers) {
      handler(event);
    }
  };

  const setActive = (tab: number | undefined): void => {
    if (tab === activeTab) {
      return;
    }
    activeTab = tab;
    for (const handler of tabHandlers) {
      handler(tab);
    }
  };

  /** Ask the browser which tab this window is showing. The answer, not a guess. */
  const readActiveTab = async (): Promise<void> => {
    const [tab] = await chrome.tabs.query({ active: true, windowId: options.windowId });
    setActive(tab?.id);
  };

  const request = async (
    tab: number,
    capability: PageCapability,
    payload?: unknown,
  ): Promise<unknown> => {
    try {
      return await relayRequestTab(tab, PAGE_ADDRESS, capability, payload);
    } catch {
      // No content script on that tab (chrome://, the web store, a tab still
      // loading): it simply has no page capabilities. Not an error — a fact.
      return undefined;
    }
  };

  /** Re-assert what this document lost. Same rule the CdpBus learned the hard
   * way: a new document carries none of what we asserted into the old one, and
   * the client's desire has not changed, so no claim re-applies on its own. */
  const replay = (tab: number): void => {
    if (ring.on) {
      void request(tab, "ring", ringForTab(ring, tab));
    }
    const held = sticky.get(tab);
    if (held?.keylayer !== undefined) {
      void request(tab, "keylayer", held.keylayer);
    }
  };

  const onReport = (tab: number, report: PageReport): void => {
    switch (report.kind) {
      case "hello":
        log(`hello ← tab ${tab}: aiui=${report.aiui} (${pageHandlers.size} subscriber(s))`);
        pageFactsFor(tab).aiui = report.aiui;
        emit({ kind: "aiuiSupport", tab, supported: report.aiui });
        replay(tab); // a fresh document (load, navigation, extension reload)
        break;
      case "selection":
        pageFactsFor(tab).selection = report.present;
        emit({ kind: "selectionPresent", tab, present: report.present });
        break;
      case "interaction":
        emit({ kind: "interaction", tab });
        break;
      case "key":
        emit({
          kind: "keyForward",
          tab,
          key: report.key,
          phase: report.phase,
          repeat: report.repeat,
        });
        break;
      case "navigation":
        emit({
          kind: "navigation",
          tab,
          from: report.from,
          to: report.to,
          navKind: report.navKind,
          // A page-reported navigation: the content script built the
          // destination's record in the page (DOM-probed aiui detection).
          ...(report.tab !== undefined ? { tabRecord: report.tab } : {}),
        });
        break;
      case "tools":
        emit({ kind: "pageTools", tab, registrations: report.registrations });
        break;
      case "toolsResult":
        emit({
          kind: "toolsResult",
          tab,
          callId: report.callId,
          ok: report.ok,
          ...(report.value !== undefined ? { value: report.value } : {}),
          ...(report.error !== undefined ? { error: report.error } : {}),
        });
        break;
      case "region":
        emit({
          kind: "regionDrag",
          tab,
          rect: report.rect,
          viewport: report.viewport,
          takenAt: report.takenAt,
          ...(report.components !== undefined ? { components: report.components } : {}),
        });
        break;
      case "jumpDone":
        emit({ kind: "jumpDone", tab });
        break;
      case "focus":
      case "stroke":
        break; // focus is the browser's business here; strokes enrich shots later
    }
  };

  // Page facts and worker navigations arrive as runtime messages. The panel
  // hears every tab's; it keeps the ones in its own window.
  const onMessage = (msg: unknown, sender: chrome.runtime.MessageSender): void => {
    const tab = sender.tab?.id;
    if (isReportMessage(msg) && tab !== undefined && sender.tab?.windowId === options.windowId) {
      onReport(tab, msg.report);
      return;
    }
    if (isNavigationMessage(msg)) {
      // From the WORKER (no sender.tab), so it carries its own tab id. The
      // worker knows only ids and URLs — a minimal synchronous record (no
      // chrome.tabs.get here: an await would reorder events around the
      // boundary; the title is usually still loading anyway).
      emit({
        kind: "navigation",
        tab: msg.tabId,
        from: msg.from,
        to: msg.to,
        navKind: msg.navKind,
        tabRecord: { url: msg.to, chromeTabId: msg.tabId },
      });
    }
  };
  chrome.runtime.onMessage.addListener(onMessage);

  // The browser tells us the active tab — no polling, no visibility heuristics.
  const onActivated = (info: chrome.tabs.TabActiveInfo): void => {
    if (info.windowId === options.windowId) {
      setActive(info.tabId);
    }
  };
  chrome.tabs.onActivated.addListener(onActivated);
  const onRemoved = (tabId: number): void => {
    sticky.delete(tabId);
    if (tabId === activeTab) {
      void readActiveTab();
    }
  };
  chrome.tabs.onRemoved.addListener(onRemoved);
  await readActiveTab();

  // The hollow ring's hint: the activation shortcut AS BOUND, read live —
  // users rebind at chrome://extensions/shortcuts, and Chrome silently drops a
  // suggested chord already claimed elsewhere (a browser shortcut, or another
  // extension), so the manifest's suggestion is NOT the truth and no key name
  // is hard-coded.
  const commands = (await chrome.commands?.getAll?.()) ?? [];
  const shortcut = commands.find((c) => c.name === ACTIVATE_COMMAND)?.shortcut ?? "";
  const grantHint = shortcut === "" ? "aiui toolbar button" : shortcut;

  const transport: PageTransport = {
    requestPage: (tab, capability, payload) => {
      if (capability === "keylayer") {
        const held = sticky.get(tab) ?? {};
        held.keylayer = payload;
        sticky.set(tab, held);
      }
      // The relay result is `unknown`; assert it to the capability's declared
      // reply here — the wire-boundary cast (a stale/foreign content script
      // could answer anything).
      return request(tab, capability, payload) as Promise<
        PageCapabilityMap[PageCapability]["reply"] | undefined
      >;
    },
    broadcastRing: (state) => {
      ring = state;
      // Every tab in THIS window: the ring is the page's only evidence of the
      // client's state, and the client belongs to one window. Projected per
      // tab — the granted tab renders solid, every other tab hollow with the
      // activation hint (the fourth ring state).
      void chrome.tabs.query({ windowId: options.windowId }).then((tabs) => {
        for (const tab of tabs) {
          if (tab.id !== undefined) {
            void request(tab.id, "ring", ringForTab(state, tab.id));
          }
        }
      });
    },
    onPageEvent: (handler) => {
      pageHandlers.add(handler);
      // Replay the cached page facts to the late subscriber — async, so the
      // register-then-receive contract holds (a handler never fires inside
      // its own registration call).
      queueMicrotask(() => {
        if (!pageHandlers.has(handler)) {
          return;
        }
        for (const [tab, facts] of pageFacts) {
          log(`page-facts replay → subscriber: tab ${tab} aiui=${facts.aiui}`);
          if (facts.aiui !== undefined) {
            handler({ kind: "aiuiSupport", tab, supported: facts.aiui });
          }
          if (facts.selection !== undefined) {
            handler({ kind: "selectionPresent", tab, present: facts.selection });
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
    tabInfo: async (tab) => {
      try {
        // This host's id namespace IS chrome.tabs — contribute the canonical
        // tab-record fields the extension can know (the boundary's <tab>
        // element renders them for MCP correlation).
        const info = await chrome.tabs.get(tab);
        return {
          url: info.url,
          title: info.title,
          chromeTabId: tab,
          ...(info.windowId !== undefined ? { windowId: info.windowId } : {}),
          ...(info.index !== undefined ? { tabIndex: info.index } : {}),
        };
      } catch {
        return undefined;
      }
    },
  };

  const capture: CaptureSource = {
    // `tabCapture` is invocation-gated per tab: it works only where the user
    // invoked the extension. The grant is REAL here — the activation gesture
    // mints it, and the pixel acts stay dark until it does.
    grantless: false,
    grantHint,
    holdStream: async (tab): Promise<HeldStream> => {
      // Measure the tab FIRST so the stream comes out tab-sized: an
      // unconstrained "tab" track aspect-fits into a display-sized frame with
      // black bars, which broke every region crop's coordinates (found live,
      // 2026-07-17 — see holdTabStream). No viewport answer (no content
      // script) → hold unconstrained; the letterbox mapping in grabTabShot
      // still lands the crop.
      // The typed viewport reply is per-tier (CDP `{ok}`, MV3 `{w,h,dpr}`);
      // narrow the union to this tier's arm.
      const vp = (await transport.requestPage(tab, "viewport")) as
        | { w: number; h: number; dpr: number }
        | undefined;
      const size =
        vp !== undefined && vp.w > 0 && vp.h > 0
          ? { width: Math.round(vp.w * vp.dpr), height: Math.round(vp.h * vp.dpr) }
          : undefined;
      await holdTabStream(
        tab,
        async (target) => {
          const { streamId } = await relayRequest<StreamIdResult>(BROKER_ADDRESS, "streamId", {
            tabId: target,
          });
          return streamId;
        },
        size,
      );
      log(
        `holding a warm tab stream for tab ${tab}${size !== undefined ? ` (${size.width}×${size.height})` : " (unconstrained)"}`,
      );
      return { tab, release: releaseTabStream };
    },
    // opts?.thumbMaxPx flows straight through — the video sampler caps the thumb,
    // a manual shot leaves it full-res for a crisp peek.
    grabShot: (_tab, opts) => grabTabShot({ thumbMaxPx: opts?.thumbMaxPx }),
    // The crop happens on the SAME warm-stream canvas as a full shot — the
    // region rect (CSS px) maps to stream pixels through the letterbox-aware
    // fit in grabTabShot. No cap: an area shot's thumb is full-res too.
    grabRegion: (_tab, rect, viewport) => grabTabShot({ region: { rect, viewport } }),
  };

  // ── driver liveness: beat every tab in this window (page/driver-watch.ts) ─
  // Same broadcast shape as the ring. Each content script's watchdog arms on
  // our assertions and hard-cleans them when the beats stop — the side panel
  // closing mid-turn, or this extension being reloaded under ext:watch (the
  // orphaned old content script hears nothing ever again), IS the beats
  // stopping. The session id is per panel BOOT: a reopened panel's first beat
  // reads as a driver CHANGE page-side (soft reset; strokes survive).
  const driverSession = crypto.randomUUID();

  // ── the liveness port: the worker's affirmative panel-close signal ────────
  // A named port for this window (protocol.ts PANEL_PORT_PREFIX). The WORKER
  // sweeps this window's pages the moment it disconnects without a prompt
  // reconnect (sw.ts) — closing the side panel cleans the pages in ~1.5 s
  // instead of the watchdog's silence timeout. Guarded: the fake chrome in
  // tests has no `runtime.connect`. A disconnect while WE are alive means the
  // worker bounced (MV3 idles it out): reconnect, which also re-wakes it.
  let livenessPort: chrome.runtime.Port | undefined;
  let portStopped = false;
  const connectLivenessPort = (): void => {
    if (portStopped || typeof chrome.runtime?.connect !== "function") {
      return;
    }
    try {
      livenessPort = chrome.runtime.connect({ name: `${PANEL_PORT_PREFIX}${options.windowId}` });
      livenessPort.onDisconnect.addListener(() => {
        livenessPort = undefined;
        if (!portStopped) {
          setTimeout(connectLivenessPort, 300);
        }
      });
    } catch {
      // The extension context is tearing down — the watchdog backup owns
      // cleanup from here.
    }
  };
  connectLivenessPort();

  const beatAll = (): void => {
    try {
      void chrome.tabs.query({ windowId: options.windowId }).then((tabs) => {
        for (const tab of tabs) {
          if (tab.id !== undefined) {
            void request(tab.id, "heartbeat", { session: driverSession });
          }
        }
      });
    } catch {
      // the extension context can die under a reload — the page watchdogs
      // handle exactly that; this timer just stops mattering
    }
  };
  // Beat immediately, not just on the interval: the first beat carries this
  // panel boot's session id, and a content script that outlived the previous
  // panel re-announces its page facts on seeing a NEW session (content.ts) —
  // that re-hello is how a page loaded before the panel opened gets its aiui/
  // selection pills lit without a manual refresh.
  beatAll();
  const beatTimer = setInterval(beatAll, HEARTBEAT_MS);

  return {
    transport,
    targeting,
    capture,
    activeTab: () => activeTab,
    dispose: () => {
      clearInterval(beatTimer);
      portStopped = true;
      livenessPort?.disconnect();
      chrome.runtime.onMessage.removeListener(onMessage);
      chrome.tabs.onActivated.removeListener(onActivated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      releaseTabStream();
    },
  };
}
