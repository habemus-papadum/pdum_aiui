/**
 * tools-link.ts — the panel's half of the page-tools bridge (T2 of the
 * plugin restructure, docs/proposals/plugin-restructure.md).
 *
 * Pages populate `window.__AIUI__.tools` and dial NOTHING; the page scripts
 * relay descriptor changes up as `pageTools` events. This module represents
 * those pages to the channel's tool directory: **one literal WebSocket per
 * tab that currently has tools** (owner-confirmed). That shape is chosen for
 * what it makes free — the directory is connection-scoped, so a closed
 * socket drops exactly that tab's namespaces (tab close = cleanup, no
 * unregister protocol), and the same app open in two tabs never collides
 * (distinct clients; `page_tools_call` disambiguates by clientId + the
 * active-tab flag).
 *
 * Downstream calls route the other way: the directory sends
 * `{type:"call", callId, ns, name, args}` on the tab's socket; we forward it
 * to the page as the `toolsCall` capability; the page's registry runs it and
 * the `toolsResult` event comes back correlated by callId; we answer
 * `{type:"result", …}`. Activation (which tab the user is looking at) rides
 * whichever socket is open — it is directory-global — sent on every active
 * tab change: the engage/disengage the retired extension's tools-link carried.
 *
 * Tab identity: the extension passes real chrome ids (`windowId` option);
 * the CDP tier's tab numbers ride as correlation HINTS (accepted decide) —
 * the directory treats `tab` as a hint, never a key.
 */

import type { IntentHost } from "./transport";

/** The socket surface we need (injectable for tests; a real ws in browsers). */
export interface ToolsSocket {
  send(data: string): void;
  close(): void;
  addEventListener(type: "open" | "message" | "close", handler: (event: never) => void): void;
}

export interface ToolsLinkOptions {
  host: IntentHost;
  /** The channel to represent pages to. */
  port: () => number | undefined;
  /** The panel's window (MV3 — real chrome ids); absent in the CDP tier. */
  windowId?: number;
  socketFactory?: (url: string) => ToolsSocket;
  log?: (message: string) => void;
}

interface TabLink {
  socket?: ToolsSocket;
  open: boolean;
  /** The tab's current registrations (re-sent on open/reconnect). */
  registrations: Array<{ ns: string; tools: unknown[] }>;
  /** Deliberate close (empty registration / dispose) — no re-dial. */
  closing: boolean;
  queue: string[];
}

const REDIAL_MS = 3000;

export function createToolsLink(options: ToolsLinkOptions): { dispose(): void } {
  const log = options.log ?? (() => {});
  const factory =
    options.socketFactory ?? ((url: string) => new WebSocket(url) as unknown as ToolsSocket);
  const links = new Map<number, TabLink>();
  /** callId → tab, so a result finds its way back to the right socket. */
  const pendingCalls = new Map<string, number>();
  let disposed = false;

  const sendOn = (link: TabLink, message: unknown): void => {
    const data = JSON.stringify(message);
    if (link.open && link.socket !== undefined) {
      link.socket.send(data);
    } else {
      link.queue.push(data);
    }
  };

  const registerAll = (tab: number, link: TabLink): void => {
    for (const registration of link.registrations) {
      sendOn(link, {
        v: 1,
        type: "register",
        ns: registration.ns,
        tools: registration.tools,
        tab: {
          chromeTabId: tab,
          ...(options.windowId !== undefined ? { windowId: options.windowId } : {}),
        },
      });
    }
  };

  const dial = (tab: number, link: TabLink): void => {
    const port = options.port();
    if (port === undefined || disposed) {
      return;
    }
    const socket = factory(`ws://127.0.0.1:${port}/tools`);
    link.socket = socket;
    link.open = false;
    socket.addEventListener("open", () => {
      link.open = true;
      for (const queued of link.queue.splice(0)) {
        socket.send(queued);
      }
    });
    socket.addEventListener("message", ((event: { data: unknown }) => {
      let msg: { type?: string; callId?: string; ns?: string; name?: string; args?: unknown };
      try {
        msg = JSON.parse(String(event.data)) as typeof msg;
      } catch {
        return;
      }
      if (msg.type === "call" && typeof msg.callId === "string") {
        // The directory asks; the PAGE answers (toolsResult event, below).
        pendingCalls.set(msg.callId, tab);
        void options.host.transport
          .requestPage(tab, "toolsCall", {
            ns: msg.ns,
            name: msg.name,
            args: msg.args,
            callId: msg.callId,
          })
          .catch(() => {
            pendingCalls.delete(msg.callId as string);
            sendOn(link, {
              v: 1,
              type: "result",
              callId: msg.callId,
              ok: false,
              error: "the page is unreachable",
            });
          });
      }
    }) as never);
    socket.addEventListener("close", () => {
      link.open = false;
      link.socket = undefined;
      if (!link.closing && !disposed && link.registrations.length > 0) {
        // The channel bounced (restart, network blip): re-dial and re-register.
        setTimeout(() => {
          if (!disposed && links.get(tab) === link && link.registrations.length > 0) {
            dial(tab, link);
            registerAll(tab, link);
          }
        }, REDIAL_MS);
      }
    });
  };

  const offPage = options.host.transport.onPageEvent((event) => {
    if (event.kind === "pageTools") {
      const existing = links.get(event.tab);
      if (event.registrations.length === 0) {
        // The page has no tools (or unloaded its last): drop the connection —
        // the directory forgets this tab's namespaces on close.
        if (existing !== undefined) {
          existing.closing = true;
          existing.socket?.close();
          links.delete(event.tab);
          log(`tools: tab ${event.tab} cleared`);
        }
        return;
      }
      const link: TabLink = existing ?? {
        open: false,
        registrations: [],
        closing: false,
        queue: [],
      };
      link.registrations = event.registrations;
      if (existing === undefined) {
        links.set(event.tab, link);
        dial(event.tab, link);
        log(`tools: tab ${event.tab} connected (${event.registrations.length} namespace(s))`);
      }
      registerAll(event.tab, link);
    } else if (event.kind === "toolsResult") {
      const tab = pendingCalls.get(event.callId);
      pendingCalls.delete(event.callId);
      const link = tab !== undefined ? links.get(tab) : undefined;
      if (link !== undefined) {
        sendOn(link, {
          v: 1,
          type: "result",
          callId: event.callId,
          ok: event.ok,
          ...(event.value !== undefined ? { value: event.value } : {}),
          ...(event.error !== undefined ? { error: event.error } : {}),
        });
      }
    }
  });

  // Engagement follows the eye: the directory flags the active tab and steers
  // ambiguous calls there. Directory-global, so any open socket carries it.
  const offTab = options.host.targeting.onActiveTabChange((tab) => {
    if (tab === undefined) {
      return;
    }
    const carrier = [...links.values()].find((link) => link.open);
    if (carrier !== undefined) {
      sendOn(carrier, {
        v: 1,
        type: "activation",
        tab: { chromeTabId: tab, windowId: options.windowId ?? 0 },
        active: true,
      });
    }
  });

  return {
    dispose: () => {
      disposed = true;
      offPage();
      offTab();
      for (const link of links.values()) {
        link.closing = true;
        link.socket?.close();
      }
      links.clear();
    },
  };
}
