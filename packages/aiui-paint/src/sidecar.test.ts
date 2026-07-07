import { createServer, type Server } from "node:http";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { paintSidecar } from "./sidecar";

/**
 * Mount the sidecar the way the channel does: an Express app on a loopback
 * http server, upgrades offered to the sidecar's handler. Everything — the
 * iPad page, both websockets, `/paint/info` — lives on this one port; whether
 * an iPad can reach it is the channel's bind decision, outside the sidecar.
 */
async function mountOnChannel() {
  const sidecar = paintSidecar({ root: "/proj/demo" });
  const app = express();
  const logs: string[] = [];
  const mounted = await sidecar.mount(app, { log: (m) => logs.push(m) });
  const server: Server = createServer(app);
  server.on("upgrade", (req, socket, head) => {
    if (!mounted.handleUpgrade?.(req, socket, head)) {
      socket.destroy();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    port,
    logs,
    mounted,
    close: async () => {
      await mounted.dispose?.();
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

let channel: Awaited<ReturnType<typeof mountOnChannel>> | undefined;
afterEach(async () => {
  await channel?.close();
  channel = undefined;
});

describe("paintSidecar", () => {
  it("serves /paint/info on the channel port", async () => {
    channel = await mountOnChannel();
    const res = await fetch(`http://127.0.0.1:${channel.port}/paint/info`);
    const info = (await res.json()) as { ok: boolean; hosts: number; clients: number };
    // The overlay's capability probe runs cross-origin (the app dev server).
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(info).toEqual({ ok: true, hosts: 0, clients: 0 });
  });

  it("serves the iPad page on the channel port", async () => {
    channel = await mountOnChannel();
    const page = await fetch(`http://127.0.0.1:${channel.port}/paint/`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("aiui paint");
  });

  it("leaves non-paint routes to the channel", async () => {
    channel = await mountOnChannel();
    const res = await fetch(`http://127.0.0.1:${channel.port}/health`);
    expect(res.status).toBe(404); // Express's own fallback, not the sidecar's
  });

  it("accepts a host and a client on the same port — one room", async () => {
    channel = await mountOnChannel();

    // The app page dials the channel port (which it already knows)…
    const host = new WebSocket(`ws://127.0.0.1:${channel.port}/paint/host`);
    await new Promise<void>((resolve, reject) => {
      host.once("open", () => resolve());
      host.once("error", reject);
    });
    host.send(JSON.stringify({ type: "register", label: "app tab" }));

    // …and the iPad dials the same port; both land in the same room state.
    const client = new WebSocket(`ws://127.0.0.1:${channel.port}/paint/client`);
    const sessions = await new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
      client.on("message", (data) => {
        const m = JSON.parse(data.toString()) as { type: string; sessions?: [] };
        if (m.type === "sessions" && (m.sessions?.length ?? 0) > 0) {
          resolve(m.sessions ?? []);
        }
      });
      client.once("error", reject);
      setTimeout(() => reject(new Error("no session broadcast")), 2000);
    });
    // The static session identity (the project root) rides along.
    expect(sessions[0]).toMatchObject({ label: "app tab", project: "/proj/demo" });
    host.close();
    client.close();
  });
});
