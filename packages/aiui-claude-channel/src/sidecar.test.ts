import type { Express } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { defaultFormats } from "./processors";
import type { MountedSidecar, Sidecar } from "./sidecar";
import { startWebServer, type WebServer } from "./web";

let server: WebServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

const start = (sidecars: Sidecar[]) =>
  startWebServer({ onPrompt: () => {}, formats: defaultFormats(), sidecars, log: () => {} });

describe("channel sidecars", () => {
  it("mounts a sidecar's routes on the Express app and disposes it on close", async () => {
    const dispose = vi.fn();
    const sidecar: Sidecar = {
      name: "demo",
      mount(app: Express): MountedSidecar {
        app.get("/demo/ping", (_req, res) => res.json({ pong: true }));
        return { dispose };
      },
    };
    server = await start([sidecar]);

    const res = await fetch(`http://127.0.0.1:${server.port}/demo/ping`);
    expect(await res.json()).toEqual({ pong: true });

    await server.close();
    server = undefined;
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("does not let a sidecar shadow the channel's own routes", async () => {
    const sidecar: Sidecar = {
      name: "greedy",
      mount(app: Express): MountedSidecar {
        // A broad handler mounted by the sidecar must still lose to /health,
        // which the channel registered first.
        app.get("/health", (_req, res) => res.json({ hijacked: true }));
        return {};
      },
    };
    server = await start([sidecar]);
    const health = await fetch(`http://127.0.0.1:${server.port}/health`).then((r) => r.json());
    expect(health.ok).toBe(true);
    expect(health.hijacked).toBeUndefined();
  });

  it("offers unclaimed websocket upgrades to sidecars, in order", async () => {
    const claimed: string[] = [];
    const passthrough: Sidecar = {
      name: "pass",
      mount: () => ({
        handleUpgrade: () => {
          claimed.push("pass");
          return false; // decline
        },
      }),
    };
    const claimer: Sidecar = {
      name: "claim",
      mount: () => ({
        handleUpgrade: (req, socket, head) => {
          claimed.push("claim");
          const wss = new WebSocketServer({ noServer: true });
          wss.handleUpgrade(req, socket, head, (ws) => {
            ws.send("hello-from-sidecar");
            ws.close();
          });
          return true;
        },
      }),
    };
    server = await start([passthrough, claimer]);

    const msg = await new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${server?.port}/anything`);
      ws.on("message", (d) => resolve(d.toString()));
      ws.on("error", reject);
    });
    expect(msg).toBe("hello-from-sidecar");
    // The passthrough sidecar was offered first and declined, then the claimer took it.
    expect(claimed).toEqual(["pass", "claim"]);
  });

  it("a sidecar whose mount throws is skipped, not fatal", async () => {
    const bad: Sidecar = {
      name: "bad",
      mount() {
        throw new Error("boom");
      },
    };
    const good: Sidecar = {
      name: "good",
      mount: (app: Express) => {
        app.get("/good", (_req, res) => res.json({ ok: true }));
        return {};
      },
    };
    server = await start([bad, good]);
    // The server still came up and the good sidecar still mounted.
    const res = await fetch(`http://127.0.0.1:${server.port}/good`).then((r) => r.json());
    expect(res.ok).toBe(true);
  });
});
