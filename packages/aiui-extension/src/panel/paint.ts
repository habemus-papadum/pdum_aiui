/**
 * iPad ink for the extension (Phase C7): the PANEL joins the channel's paint
 * sidecar as a host — the same `startPaintHost` the overlay page uses, with
 * the panel's own seams:
 *
 *  - **view**: JPEG frames off the panel's WARM tabCapture stream (the same
 *    stream shots and video sampling draw from) — the iPad watches the active
 *    tab, not the panel (tab captures never include the side panel, measured).
 *  - **ink**: stroke intents land as one-way `aiuiRemoteInk` ops on the ACTIVE
 *    TAB's content script, in tab CSS pixels (`size()` reports the tab's
 *    viewport, so aiui-paint's normalized→px mapping is tab-correct). The
 *    content surface's `onRemoteStrokeEnd` relays the finished stroke to the
 *    engine exactly like a local pen-up (C2a's hook, built for this).
 *  - **arm**: an iPad arming gesture opens a turn (the host's `openTurn`
 *    callback — the ⌘B analog; capture stays invocation-gated, so a tab never
 *    ⌘B'd streams no frames until it is).
 *
 * Probe-before-dial, like the overlay's paint-host.ts: only a channel with
 * the sidecar answers `GET /paint/info`; without one this module is a no-op.
 */
import { type InkSink, startPaintHost } from "@habemus-papadum/aiui-paint";

export interface PanelPaintDeps {
  /** The bound channel port (undefined = no channel). */
  port: () => number | undefined;
  /** The active tab's id + viewport CSS size (cached by the panel). */
  activeTab: () => { tabId: number; width: number; height: number } | undefined;
  /** One JPEG frame off the warm stream, or undefined when none is held. */
  captureFrame: () => Promise<Uint8Array | undefined>;
  /** iPad armed the tool: make sure a turn is open (the ⌘B analog). */
  openTurn: (on: boolean) => void;
  /** Forward one remote-ink op to the tab (fire-and-forget). */
  sendInk: (tabId: number, op: object) => void;
  log: (...parts: unknown[]) => void;
}

export interface PanelPaint {
  /** (Re)connect against the current channel — call when the binding changes. */
  sync(): void;
  dispose(): void;
}

export function createPanelPaint(deps: PanelPaintDeps): PanelPaint {
  let host: { close(): void } | undefined;
  let connectedPort: number | undefined;

  const connect = async (port: number): Promise<void> => {
    try {
      const info = await fetch(`http://127.0.0.1:${port}/paint/info`);
      if (!info.ok) {
        return; // no sidecar on this channel — a plain no-op
      }
    } catch {
      return;
    }
    host = startPaintHost({
      relayUrl: `http://127.0.0.1:${port}`,
      label: "browser tab (aiui panel)",
      channelPort: port,
      video: "jpeg",
      ink: {
        setArmed: (on) => deps.openTurn(on),
        size: () => {
          const tab = deps.activeTab();
          return { width: tab?.width ?? 1280, height: tab?.height ?? 800 };
        },
        beginStroke: (id, style, point) => {
          const tab = deps.activeTab();
          if (tab) {
            deps.sendInk(tab.tabId, { aiuiRemoteInk: 1, op: "begin", id, style, point });
          }
        },
        extendStroke: (id, point) => {
          const tab = deps.activeTab();
          if (tab) {
            deps.sendInk(tab.tabId, { aiuiRemoteInk: 1, op: "point", id, point });
          }
        },
        endStroke: (id, point) => {
          const tab = deps.activeTab();
          if (tab) {
            deps.sendInk(tab.tabId, { aiuiRemoteInk: 1, op: "end", id, point });
          }
        },
        cancelStroke: (id) => {
          const tab = deps.activeTab();
          if (tab) {
            deps.sendInk(tab.tabId, { aiuiRemoteInk: 1, op: "cancel", id });
          }
        },
      } satisfies InkSink,
      frameSource: {
        start: async () => "active" as const,
        lastError: () => undefined,
        capture: () => deps.captureFrame(),
        stream: () => undefined, // JPEG mode: frames only, no MediaStream
        stop: () => {},
      },
    });
    connectedPort = port;
    deps.log("paint host up on :" + String(port), "(iPad ink ready)");
  };

  return {
    sync() {
      const port = deps.port();
      if (port === connectedPort) {
        return;
      }
      host?.close();
      host = undefined;
      connectedPort = undefined;
      if (port !== undefined) {
        void connect(port);
      }
    },
    dispose() {
      host?.close();
      host = undefined;
    },
  };
}
