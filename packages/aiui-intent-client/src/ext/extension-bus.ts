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

import { relayRequest, relayRequestTab } from "@habemus-papadum/aiui-webext";
import type { PageReport } from "../cdp/page-script";
import {
  type CaptureSource,
  type HeldStream,
  type IntentHost,
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
  type StreamIdResult,
} from "./protocol";

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
  const sticky = new Map<number, { keylayer?: unknown; ink?: unknown }>();
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

  const request = async (tab: number, capability: string, payload?: unknown): Promise<unknown> => {
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
    if (held?.ink !== undefined) {
      void request(tab, "ink", held.ink);
    }
  };

  const onReport = (tab: number, report: PageReport): void => {
    switch (report.kind) {
      case "hello":
        emit({ kind: "aiuiSupport", tab, supported: report.aiui });
        replay(tab); // a fresh document (load, navigation, extension reload)
        break;
      case "selection":
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
        });
        break;
      case "foreign":
        emit({ kind: "foreignClient", tab, armed: report.armed });
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
      // From the WORKER (no sender.tab), so it carries its own tab id.
      emit({
        kind: "navigation",
        tab: msg.tabId,
        from: msg.from,
        to: msg.to,
        navKind: msg.navKind,
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
  // conflicted suggestion (the frozen client claims the same chord), so the
  // manifest's suggestion is NOT the truth and no key name is hard-coded.
  const commands = (await chrome.commands?.getAll?.()) ?? [];
  const shortcut = commands.find((c) => c.name === ACTIVATE_COMMAND)?.shortcut ?? "";
  const grantHint = shortcut === "" ? "aiui toolbar button" : shortcut;

  const transport: PageTransport = {
    requestPage: (tab, capability, payload) => {
      if (capability === "keylayer" || capability === "ink") {
        const held = sticky.get(tab) ?? {};
        held[capability] = payload;
        sticky.set(tab, held);
      }
      return request(tab, capability, payload);
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
        const info = await chrome.tabs.get(tab);
        return { url: info.url, title: info.title };
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
      await holdTabStream(tab, async (target) => {
        const { streamId } = await relayRequest<StreamIdResult>(BROKER_ADDRESS, "streamId", {
          tabId: target,
        });
        return streamId;
      });
      log(`holding a warm tab stream for tab ${tab}`);
      return { tab, release: releaseTabStream };
    },
    grabShot: () => grabTabShot(),
    // The crop happens on the SAME warm-stream canvas as a full shot — the
    // region rect (CSS px) maps to stream pixels by the viewport width.
    grabRegion: (_tab, rect, viewport) => grabTabShot({ rect, viewport }),
  };

  return {
    transport,
    targeting,
    capture,
    activeTab: () => activeTab,
    dispose: () => {
      chrome.runtime.onMessage.removeListener(onMessage);
      chrome.tabs.onActivated.removeListener(onActivated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      releaseTabStream();
    },
  };
}
