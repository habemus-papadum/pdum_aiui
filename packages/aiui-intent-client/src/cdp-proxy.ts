/**
 * cdp-proxy.ts — the sidecar's `/intent/cdp` websocket: the ONE reason the
 * CdpBus needs a server half.
 *
 * Chrome guards its debug port against the web: `/json/version` carries no CORS
 * headers, and the browser endpoint REJECTS a websocket upgrade whose `Origin`
 * is a page (that guard is exactly what stops a random site from driving your
 * browser). Our panel *is* a page. So the page dials its own origin — the
 * channel — and the channel, a node process with no Origin to send, bridges to
 * the browser's CDP socket. Nothing else about the tier changes: the bytes are
 * plain CDP in both directions.
 *
 * Discovery, server-side, in the order the launcher itself would:
 *   1. the channel's own launch info (`GET /debug/api/info` →
 *      `launch.chromeDevtools.browserUrl`) — authoritative: it is what
 *      `aiui claude` handed the chrome-devtools MCP, whatever the profile;
 *   2. the user-level session-browser profiles (`~/.cache/aiui/userdata/**`)
 *      via `discoverSessionBrowserInProfiles`, first LIVE DevToolsActivePort
 *      wins. A debug channel has no launch info, so this rung is its whole
 *      discovery. The legacy project-local `.aiui-cache/chrome/**` is NOT
 *      scanned: an orphan browser an old checkout left there is not this
 *      session's, and mistaking it for one produced a phantom "endpoint moved"
 *      warning (2026-07-20).
 *
 * **Loopback only.** The CDP port is root of the browser (docs/guide/chrome.md),
 * so this proxy refuses to bridge to anything but 127.0.0.1/::1 — a tunneled or
 * remote browser (`chrome.browserUrl`) deliberately gets no bridge. That is a
 * check on WHERE WE DIAL, not on who dialed us: like every other route on the
 * channel's port, reachability is the `channel.bind` decision, and on
 * `bind: host` this hands anyone on the LAN the session browser. That is the
 * trusted-LAN posture, stated plainly in docs/guide/warning.md — read it before
 * running this on a network you don't own.
 */

import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import {
  discoverSessionBrowser,
  discoverSessionBrowserInProfiles,
  rehostSocketUrl,
} from "@habemus-papadum/aiui-util";
import { WebSocket, WebSocketServer } from "ws";

/** How the panel asks whether this tier is even available. */
export interface CdpProxyInfo {
  ok: true;
  /** True when a loopback session browser answered and can be bridged. */
  available: boolean;
  /** The endpoint we would bridge to (loopback), when available. */
  browserUrl?: string;
  /** Why not, when unavailable (shown in the panel's channel pill tooltip). */
  reason?: string;
}

export interface CdpProxyOptions {
  /**
   * Project root — carried for the sidecar family's shared shape. Discovery no
   * longer reads it: session-browser profiles are user-level
   * (`~/.cache/aiui/userdata/**`), scanned globally, not under the project.
   */
  root?: string;
  log?: (message: string) => void;
  /** Test seam: resolve the browser endpoint (bypasses discovery). */
  discover?: (channelPort?: number) => Promise<string | undefined>;
  /** Test seam: dial the upstream CDP socket. */
  dial?: (url: string) => WebSocket;
}

export interface CdpProxy {
  info(channelPort?: number): Promise<CdpProxyInfo>;
  /** Claim `/intent/cdp` upgrades. Returns false for anything else. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean;
  dispose(): void;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export function isLoopbackEndpoint(url: string): boolean {
  try {
    return LOOPBACK_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * The channel's launch info — what `aiui claude` told the server it wired,
 * i.e. the endpoint the chrome-devtools MCP was pinned to at launch. The
 * endpoint watcher (sidecar.ts) anchors on THIS, never on a profile scan.
 */
export async function browserUrlFromLaunchInfo(channelPort: number): Promise<string | undefined> {
  try {
    const res = await fetch(`http://127.0.0.1:${channelPort}/debug/api/info`, {
      signal: AbortSignal.timeout(1000),
    });
    if (!res.ok) {
      return undefined;
    }
    const info = (await res.json()) as {
      launch?: { chromeDevtools?: { browserUrl?: string } };
    };
    return info.launch?.chromeDevtools?.browserUrl;
  } catch {
    return undefined;
  }
}

/** The browser's own CDP websocket, from an endpoint we are allowed to dial. */
async function browserSocketUrl(browserUrl: string): Promise<string> {
  const base = browserUrl.replace(/\/+$/, "");
  const res = await fetch(`${base}/json/version`, { signal: AbortSignal.timeout(2000) });
  if (!res.ok) {
    throw new Error(`the browser's DevTools endpoint answered ${res.status}`);
  }
  const { webSocketDebuggerUrl } = (await res.json()) as { webSocketDebuggerUrl?: string };
  if (!webSocketDebuggerUrl) {
    throw new Error("the browser's DevTools endpoint exposes no webSocketDebuggerUrl");
  }
  return rehostSocketUrl(webSocketDebuggerUrl, base);
}

export function createCdpProxy(options: CdpProxyOptions = {}): CdpProxy {
  const log = options.log ?? (() => {});
  const wss = new WebSocketServer({ noServer: true });
  const dial = options.dial ?? ((url: string) => new WebSocket(url));

  const discover =
    options.discover ??
    (async (channelPort?: number): Promise<string | undefined> => {
      // An explicit AIUI_USER_DATA_DIR wins over everything: the operator is
      // POINTING at a profile (e.g. `pnpm test-app:channel` against a browser
      // some other checkout launched) — read its DevToolsActivePort directly.
      const explicitProfile = process.env.AIUI_USER_DATA_DIR;
      if (explicitProfile !== undefined && explicitProfile !== "") {
        return (await discoverSessionBrowser(explicitProfile))?.browserUrl;
      }
      if (channelPort !== undefined) {
        const fromLaunch = await browserUrlFromLaunchInfo(channelPort);
        if (fromLaunch !== undefined) {
          return fromLaunch;
        }
      }
      return (await discoverSessionBrowserInProfiles())?.browserUrl;
    });

  /** Resolve an endpoint we are willing to bridge to, or say why not. */
  const endpoint = async (channelPort?: number): Promise<{ url?: string; reason?: string }> => {
    const browserUrl = await discover(channelPort);
    if (browserUrl === undefined) {
      return { reason: "no session browser is running (launch one with `aiui claude`)" };
    }
    if (!isLoopbackEndpoint(browserUrl)) {
      return {
        reason: `the session browser is not local (${browserUrl}) — the CDP bridge stays loopback-only`,
      };
    }
    return { url: browserUrl };
  };

  /**
   * Bridge one panel socket to the browser. Discovery and the upstream dial are
   * async, but the panel is ALREADY talking — its bus fires `Target.setAutoAttach`
   * the moment its socket opens. So the queue starts synchronously, before the
   * first await: a `ws` socket with no `message` listener drops what arrives (it
   * is an EventEmitter, not a buffer), and a dropped setAutoAttach is a bus that
   * attaches to nothing, silently.
   */
  const bridge = (client: WebSocket, channelPort?: number): void => {
    const queued: string[] = [];
    let upstream: WebSocket | undefined;

    client.on("message", (data) => {
      const message = data.toString();
      if (upstream !== undefined && upstream.readyState === WebSocket.OPEN) {
        upstream.send(message);
      } else {
        queued.push(message);
      }
    });

    const drop = (): void => {
      if (client.readyState === WebSocket.OPEN) {
        client.close();
      }
      if (
        upstream?.readyState === WebSocket.OPEN ||
        upstream?.readyState === WebSocket.CONNECTING
      ) {
        upstream.close();
      }
    };
    client.on("close", drop);
    client.on("error", drop);

    void (async () => {
      const { url, reason } = await endpoint(channelPort);
      if (url === undefined) {
        log(`cdp proxy: refusing to bridge — ${reason}`);
        client.close(1011, reason);
        return;
      }
      try {
        upstream = dial(await browserSocketUrl(url));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log(`cdp proxy: ${message}`);
        client.close(1011, message);
        return;
      }
      upstream.on("open", () => {
        for (const message of queued.splice(0)) {
          upstream?.send(message);
        }
      });
      upstream.on("message", (data) => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(data.toString());
        }
      });
      upstream.on("close", drop);
      upstream.on("error", drop);
      log(`cdp proxy: bridged a panel to ${url}`);
    })();
  };

  return {
    info: async (channelPort) => {
      const { url, reason } = await endpoint(channelPort);
      return url !== undefined
        ? { ok: true, available: true, browserUrl: url }
        : { ok: true, available: false, reason };
    },
    handleUpgrade: (req, socket, head) => {
      const path = (req.url ?? "").split("?")[0];
      if (path !== "/intent/cdp") {
        return false;
      }
      const channelPort = Number(req.headers.host?.split(":")[1]);
      wss.handleUpgrade(req, socket, head, (client) => {
        bridge(client, Number.isInteger(channelPort) ? channelPort : undefined);
      });
      return true;
    },
    dispose: () => wss.close(),
  };
}
