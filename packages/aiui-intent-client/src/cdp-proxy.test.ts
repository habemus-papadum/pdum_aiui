/**
 * The `/intent/cdp` bridge: the one server-side piece of the CDP tier.
 *
 * The end-to-end row runs a REAL socket through it — a stand-in browser with a
 * `/json/version` route and a CDP websocket — because the interesting failure
 * is timing, not shape: the panel sends `Target.setAutoAttach` the instant its
 * socket opens, which is BEFORE the proxy's upstream socket is up. Dropping
 * that first command would leave a bus that attaches to nothing, silently.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { createCdpProxy, isLoopbackEndpoint } from "./cdp-proxy";

const servers: Server[] = [];
const listen = async (server: Server): Promise<number> => {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
};

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.close();
  }
});

/** A browser's debug endpoint, as far as the proxy can tell. */
async function standInBrowser(): Promise<{ browserUrl: string }> {
  const server = createServer((req, res) => {
    if (req.url === "/json/version") {
      const { port } = server.address() as AddressInfo;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/abc`,
        }),
      );
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  const wss = new WebSocketServer({ server, path: "/devtools/browser/abc" });
  wss.on("connection", (socket) => {
    socket.on("message", (data) => {
      const command = JSON.parse(data.toString()) as { id: number; method: string };
      socket.send(JSON.stringify({ id: command.id, result: { saw: command.method } }));
    });
  });
  const port = await listen(server);
  return { browserUrl: `http://127.0.0.1:${port}` };
}

describe("the CDP bridge", () => {
  it("knows a loopback endpoint from a routable one", () => {
    expect(isLoopbackEndpoint("http://127.0.0.1:9222")).toBe(true);
    expect(isLoopbackEndpoint("http://localhost:9222")).toBe(true);
    expect(isLoopbackEndpoint("http://192.168.1.9:9222")).toBe(false);
    expect(isLoopbackEndpoint("not a url")).toBe(false);
  });

  it("reports availability, and says why not", async () => {
    const up = createCdpProxy({ discover: async () => "http://127.0.0.1:9222" });
    expect(await up.info()).toEqual({
      ok: true,
      available: true,
      browserUrl: "http://127.0.0.1:9222",
    });

    const none = createCdpProxy({ discover: async () => undefined });
    expect(await none.info()).toMatchObject({ available: false, reason: /no session browser/ });
  });

  it("refuses to bridge to a browser that isn't on this machine", async () => {
    // A tunneled/remote `chrome.browserUrl` deliberately gets no bridge: the
    // debug port is root of the browser and stays a local dev affordance.
    const remote = createCdpProxy({ discover: async () => "http://10.0.0.7:9222" });
    const info = await remote.info();
    expect(info.available).toBe(false);
    expect(info.reason).toMatch(/loopback-only/);
  });

  it("claims only its own upgrade path", async () => {
    const proxy = createCdpProxy({ discover: async () => undefined });
    const fake = { url: "/pencil/host", headers: {} } as never;
    expect(proxy.handleUpgrade(fake, {} as never, Buffer.alloc(0))).toBe(false);
    proxy.dispose();
  });

  it("bridges a panel to the browser, holding the commands it sends before the upstream opens", async () => {
    const { browserUrl } = await standInBrowser();
    const proxy = createCdpProxy({ discover: async () => browserUrl });
    const host = createServer();
    host.on("upgrade", (req, socket, head) => {
      if (!proxy.handleUpgrade(req, socket, head)) {
        socket.destroy();
      }
    });
    const port = await listen(host);

    const panel = new WebSocket(`ws://127.0.0.1:${port}/intent/cdp`);
    const replies: Array<{ id: number; result: { saw: string } }> = [];
    const first = new Promise<void>((resolve) => {
      panel.on("message", (data) => {
        replies.push(JSON.parse(data.toString()));
        resolve();
      });
    });
    // The bus's very first command, sent the moment ITS socket opens — long
    // before the proxy has finished dialing the browser.
    panel.on("open", () => {
      panel.send(JSON.stringify({ id: 1, method: "Target.setAutoAttach", params: {} }));
    });

    await first;
    expect(replies).toEqual([{ id: 1, result: { saw: "Target.setAutoAttach" } }]);
    panel.close();
    proxy.dispose();
  });

  it("closes the panel's socket with the reason when there is no browser to bridge to", async () => {
    const proxy = createCdpProxy({ discover: async () => undefined });
    const host = createServer();
    host.on("upgrade", (req, socket, head) => {
      if (!proxy.handleUpgrade(req, socket, head)) {
        socket.destroy();
      }
    });
    const port = await listen(host);

    const panel = new WebSocket(`ws://127.0.0.1:${port}/intent/cdp`);
    const closed = await new Promise<string>((resolve) => {
      panel.on("close", (_code, reason) => resolve(reason.toString()));
    });
    expect(closed).toMatch(/no session browser/);
    proxy.dispose();
  });
});
