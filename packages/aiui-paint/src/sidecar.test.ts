import { createServer, type Server } from "node:http";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { paintSidecar } from "./sidecar";

/**
 * Mount the sidecar the way the channel does: an Express app on a loopback
 * http server, upgrades offered to the sidecar's handler. The LAN face is the
 * sidecar's own listener — bound to 127.0.0.1 here so a test machine's
 * firewall stays quiet; port 0 avoids clashing with a real session's 8788.
 */
async function mountOnChannel() {
  const sidecar = paintSidecar({ root: "/proj/demo", lanPort: 0, lanHost: "127.0.0.1" });
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
  it("serves /paint/info on the loopback face, reporting the LAN face", async () => {
    channel = await mountOnChannel();
    const info = (await (await fetch(`http://127.0.0.1:${channel.port}/paint/info`)).json()) as {
      ok: boolean;
      lan?: { port: number; urls: string[] };
      hosts: number;
    };
    expect(info.ok).toBe(true);
    expect(info.lan?.port).toBeGreaterThan(0);
    expect(info.hosts).toBe(0);
  });

  it("serves the iPad page on the LAN face, with a root redirect", async () => {
    channel = await mountOnChannel();
    const { lan } = (await (await fetch(`http://127.0.0.1:${channel.port}/paint/info`)).json()) as {
      lan: { port: number };
    };

    const page = await fetch(`http://127.0.0.1:${lan.port}/paint/`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("aiui paint");

    const redirect = await fetch(`http://127.0.0.1:${lan.port}/`, { redirect: "manual" });
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get("location")).toBe("/paint/");
  });

  it("accepts a host on the loopback face and a client on the LAN face — one room", async () => {
    channel = await mountOnChannel();
    const { lan } = (await (await fetch(`http://127.0.0.1:${channel.port}/paint/info`)).json()) as {
      lan: { port: number };
    };

    // The app page dials the channel port (which it already knows)…
    const host = new WebSocket(`ws://127.0.0.1:${channel.port}/paint/host`);
    await new Promise<void>((resolve, reject) => {
      host.once("open", () => resolve());
      host.once("error", reject);
    });
    host.send(JSON.stringify({ type: "register", label: "app tab" }));

    // …and the iPad dials the LAN face; both land in the same room state.
    const client = new WebSocket(`ws://127.0.0.1:${lan.port}/paint/client`);
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

  it("dispose closes the LAN listener", async () => {
    channel = await mountOnChannel();
    const { lan } = (await (await fetch(`http://127.0.0.1:${channel.port}/paint/info`)).json()) as {
      lan: { port: number };
    };
    await channel.mounted.dispose?.();

    await expect(fetch(`http://127.0.0.1:${lan.port}/paint/`)).rejects.toThrow();
  });
});
