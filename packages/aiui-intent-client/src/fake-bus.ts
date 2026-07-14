/**
 * fake-bus.ts — the in-memory host: every harness test drives the client
 * through this, and the detached dev page can too (a client with no real
 * pages is still a fully exercisable client).
 *
 * Design: everything observable, nothing hidden. Requests append to `log`
 * (human-readable strings — assertions read like the bug ledger), ring
 * broadcasts are recorded AND kept as `lastRing`, and inbound events (page
 * pings, tab switches) are methods the test calls. Capabilities can be made
 * to fail per-tab to exercise claim error paths.
 */

import type {
  CaptureSource,
  HeldStream,
  IntentHost,
  PageEvent,
  PageTransport,
  PanelShot,
  RingState,
  SurfaceTargeting,
} from "./transport";

export interface FakeBus extends IntentHost {
  /** Every request/broadcast/hold/shot, in order, as readable strings. */
  readonly log: string[];
  /** The most recent ring assertion (undefined until the first). */
  lastRing: RingState | undefined;
  /** Currently held (un-released) streams, by tab. */
  heldStreams(): number[];
  /** Simulate the user switching tabs. */
  switchTab(tab: number | undefined): void;
  /** Set a fake tab's identity (tab-boundary events read it via tabInfo). */
  setTabUrl(tab: number, url: string, title?: string): void;
  /** Push a page event at the panel (selection ping, interaction, key). */
  firePageEvent(event: PageEvent): void;
  /** Make a capability start failing (claim error paths). */
  failCapability(capability: string, error: string): void;
  /** Clear the log (keeps state — mid-scenario checkpoints). */
  clearLog(): void;
}

export function fakeBus(
  options: { activeTab?: number; grantless?: boolean; grantHint?: string } = {},
): FakeBus {
  const log: string[] = [];
  const failures = new Map<string, string>();
  const pageHandlers = new Set<(event: PageEvent) => void>();
  const tabHandlers = new Set<(tab: number | undefined) => void>();
  const held = new Map<number, HeldStream>();
  let activeTab = options.activeTab;
  let ringCount = 0;

  const transport: PageTransport = {
    requestPage: (tab, capability, payload) => {
      const failure = failures.get(capability);
      if (failure !== undefined) {
        log.push(`page:${capability}@${tab} FAILED(${failure})`);
        return Promise.reject(new Error(failure));
      }
      log.push(`page:${capability}@${tab} ${JSON.stringify(payload) ?? ""}`.trimEnd());
      return Promise.resolve(undefined);
    },
    broadcastRing: (state) => {
      ringCount += 1;
      bus.lastRing = state;
      const grant =
        state.grant !== undefined ? ` grant=${state.grant.tab ?? "none"}(${state.grant.hint})` : "";
      log.push(`ring#${ringCount} on=${state.on} turn=${state.turnTone}${grant}`);
    },
    onPageEvent: (handler) => {
      pageHandlers.add(handler);
      return () => pageHandlers.delete(handler);
    },
  };

  const tabUrls = new Map<number, { url: string; title?: string }>();
  const targeting: SurfaceTargeting = {
    activeTab: () => activeTab,
    onActiveTabChange: (handler) => {
      tabHandlers.add(handler);
      return () => tabHandlers.delete(handler);
    },
    tabInfo: (tab) =>
      Promise.resolve(tabUrls.get(tab) ?? { url: `fake://tab/${tab}`, title: `tab ${tab}` }),
  };

  const capture: CaptureSource = {
    // Model either host: MV3's per-tab invocation gate (a grant the activation
    // gesture mints) or the CDP tier's grantless screenshots.
    grantless: options.grantless === true,
    ...(options.grantHint !== undefined ? { grantHint: options.grantHint } : {}),
    holdStream: (tab) => {
      const failure = failures.get("stream");
      if (failure !== undefined) {
        log.push(`stream:hold@${tab} FAILED(${failure})`);
        return Promise.reject(new Error(failure));
      }
      const stream: HeldStream = {
        tab,
        release: () => {
          held.delete(tab);
          log.push(`stream:release@${tab}`);
        },
      };
      held.set(tab, stream);
      log.push(`stream:hold@${tab}`);
      return Promise.resolve(stream);
    },
    grabShot: (tab) => {
      const failure = failures.get("shot");
      if (failure !== undefined) {
        return Promise.reject(new Error(failure));
      }
      log.push(`shot@${tab}`);
      const shot: PanelShot = { width: 2, height: 2, mime: "image/png", bytes: new Uint8Array(4) };
      return Promise.resolve(shot);
    },
  };

  const bus: FakeBus = {
    transport,
    targeting,
    capture,
    log,
    lastRing: undefined,
    heldStreams: () => [...held.keys()],
    switchTab: (tab) => {
      activeTab = tab;
      for (const handler of tabHandlers) {
        handler(tab);
      }
    },
    setTabUrl: (tab, url, title) => {
      tabUrls.set(tab, { url, ...(title !== undefined ? { title } : {}) });
    },
    firePageEvent: (event) => {
      for (const handler of pageHandlers) {
        handler(event);
      }
    },
    failCapability: (capability, error) => {
      failures.set(capability, error);
    },
    clearLog: () => {
      log.length = 0;
    },
  };
  return bus;
}
