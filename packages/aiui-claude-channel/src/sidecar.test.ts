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

  it("contains a sidecar whose handleUpgrade throws — the server survives", async () => {
    const throwing: Sidecar = {
      name: "explosive",
      mount: () => ({
        handleUpgrade: () => {
          throw new Error("upgrade boom");
        },
      }),
    };
    server = await start([throwing]);

    // An unclaimed upgrade path reaches the sidecar, which throws; the channel
    // must contain it (log + drop the socket), not die on an uncaughtException.
    await new Promise<void>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${server?.port}/anything`);
      ws.on("error", () => resolve()); // socket dropped, as expected
      ws.on("close", () => resolve());
    });

    const health = await fetch(`http://127.0.0.1:${server.port}/health`).then((r) => r.json());
    expect(health.ok).toBe(true);
  });

  it("drops a malformed upgrade request-target without dying", async () => {
    server = await start([]);
    // `GET //[ HTTP/1.1` passes Node's parser but not WHATWG URL parsing; send it
    // raw so nothing normalizes the path.
    const { connect } = await import("node:net");
    await new Promise<void>((resolve) => {
      const sock = connect(server?.port ?? 0, "127.0.0.1", () => {
        sock.write(
          "GET //[ HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
        );
      });
      sock.on("close", () => resolve());
      sock.on("error", () => resolve());
      setTimeout(() => {
        sock.destroy();
        resolve();
      }, 1000);
    });
    const health = await fetch(`http://127.0.0.1:${server.port}/health`).then((r) => r.json());
    expect(health.ok).toBe(true);
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
