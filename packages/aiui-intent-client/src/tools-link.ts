/**
 * tools-link.ts — the panel's half of the page-tools bridge (T2 of the
 * plugin-restructure proposal, git history).
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
  registrations: Array<{ ns: string; tools: unknown[]; active?: boolean }>;
  /** The tab's identity (url/title), fetched once per link — rides every
   * register so the directory's ambiguity messages can NAME the page. */
  meta?: { url?: string; title?: string };
  /** Deliberate close (empty registration / dispose) — no re-dial. */
  closing: boolean;
  queue: string[];
}

const REDIAL_MS = 3000;

/** A cheap, stable content hash (djb2 over the canonical JSON). The directory
 * keys its change detection on `ns|hash` — with no hash every registration
 * looked identical, so a tool-set CHANGE inside a namespace never fired
 * `tools/list_changed` (found by the channel-plumbing audit, 2026-08-03).
 * The ACTIVITY bit is deliberately excluded: a route flip re-registers with
 * an unchanged hash, so the directory updates the record without announcing
 * "page tools changed" on every gallery navigation (the same reason the
 * directory's signature excludes the active-tab flag). */
export function toolsHash(registration: { ns: string; tools: unknown[] }): string {
  const canon = JSON.stringify({ ns: registration.ns, tools: registration.tools });
  let h = 5381;
  for (let i = 0; i < canon.length; i++) {
    h = ((h << 5) + h + canon.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16);
}

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
        // The namespace's activity bit + a content hash: the directory's
        // change detection keys on the hash, projections filter on the bit.
        active: registration.active !== false,
        hash: toolsHash(registration),
        ...(link.meta?.url !== undefined ? { url: link.meta.url } : {}),
        tab: {
          chromeTabId: tab,
          ...(options.windowId !== undefined ? { windowId: options.windowId } : {}),
          ...(link.meta?.url !== undefined ? { url: link.meta.url } : {}),
          ...(link.meta?.title !== undefined ? { title: link.meta.title } : {}),
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
      // A directory `{type:"call"}` message carries ns/name (the module doc's
      // contract); the parse is an unchecked JSON assertion, and the page
      // handler coerces defensively regardless.
      let msg: { type?: string; callId?: string; ns: string; name: string; args?: unknown };
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
        // The tab's identity, once per link — best-effort, then re-register
        // so the directory's records (and its ambiguity messages) carry the
        // page's url/title instead of a bare clientId.
        void options.host.targeting
          .tabInfo?.(event.tab)
          .then((info) => {
            if (info !== undefined && links.get(event.tab) === link) {
              link.meta = { url: info.url, title: info.title };
              registerAll(event.tab, link);
            }
          })
          .catch(() => {});
      }
      registerAll(event.tab, link);
    } else if (event.kind === "tabClosed") {
      // The tab is GONE: close its socket so the directory forgets its
      // namespaces (close = cleanup, the connection-scoped contract). This is
      // the leak fix — without it, a closed tab's registrations shadowed the
      // reopened app's forever (the duplicate testapp/report, 2026-08-03).
      const link = links.get(event.tab);
      if (link !== undefined) {
        link.closing = true;
        link.socket?.close();
        links.delete(event.tab);
        log(`tools: tab ${event.tab} closed — namespaces dropped`);
      }
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
