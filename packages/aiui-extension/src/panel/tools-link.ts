/**
 * The panel's `/tools` link: tab-activation reporting for the channel's
 * page-tool directory (browser-extension proposal §7; wire shape defined by
 * the channel: `{v:1, type:"activation", tab:{chromeTabId, windowId},
 * active:true}`). One message at connect (the window's current active tab),
 * one per `tabs.onActivated` in this window — the directory flips `activeTab`
 * flags, re-routes ambiguous `page_tools_call`s to the active tab, and its
 * change signal drives `tools/list_changed` + the named-tools session push.
 *
 * Registrations do NOT travel here: an aiui-instrumented page's own tools
 * bridge already dials the channel directly. This link only contributes what
 * a page cannot know — which tab the user is looking at. Activation state is
 * directory-global and dies with the channel process, so every (re)connect
 * re-sends the current tab.
 */

export interface ToolsLink {
  close(): void;
}

const RECONNECT_MS = 3000;

export function connectToolsLink(opts: { port: number; windowId: number }): ToolsLink {
  let socket: WebSocket | undefined;
  let closed = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  const sendActivation = (chromeTabId: number): void => {
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(
        JSON.stringify({
          v: 1,
          type: "activation",
          tab: { chromeTabId, windowId: opts.windowId },
          active: true,
        }),
      );
    }
  };

  const onActivated = (info: chrome.tabs.TabActiveInfo): void => {
    if (info.windowId === opts.windowId) {
      sendActivation(info.tabId);
    }
  };

  const dial = (): void => {
    if (closed) {
      return;
    }
    const ws = new WebSocket(`ws://127.0.0.1:${opts.port}/tools`);
    socket = ws;
    ws.addEventListener("open", () => {
      void chrome.tabs.query({ active: true, windowId: opts.windowId }).then(([tab]) => {
        if (tab?.id !== undefined) {
          sendActivation(tab.id);
        }
      });
    });
    ws.addEventListener("close", () => {
      socket = undefined;
      if (!closed) {
        reconnectTimer = setTimeout(dial, RECONNECT_MS);
      }
    });
    ws.addEventListener("error", () => {
      // close follows; the reconnect loop handles it
    });
  };

  chrome.tabs.onActivated.addListener(onActivated);
  dial();

  return {
    close() {
      closed = true;
      chrome.tabs.onActivated.removeListener(onActivated);
      if (reconnectTimer !== undefined) {
        clearTimeout(reconnectTimer);
      }
      socket?.close();
      socket = undefined;
    },
  };
}
