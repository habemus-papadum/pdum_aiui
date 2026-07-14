/**
 * sidecar.test.ts — the channel seam, exercised with no channel and no overlay.
 *
 * `aiui claude`'s channel mounts sidecars through exactly two hooks: each
 * sidecar's `mount(app, ctx)` on one Express app, and a fan-out of websocket
 * upgrades to `handleUpgrade`. This test IS that host, minus everything else —
 * a plain Express server carrying the pencil sidecar AND the bar sidecar side
 * by side, the way a real session serves them. If this passes, "integrating
 * the sidecar" needs nothing from the overlay: the seam is the whole story.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MountedSidecar } from "@habemus-papadum/aiui-claude-channel";
import { barSidecar } from "@habemus-papadum/aiui-remote-bar/sidecar";
import express from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { pencilSidecar } from "./sidecar";

/** Both channels frame identically: JSON text with a string `type`. The test
 * speaks raw frames so one helper can drive either sidecar's sockets. */
type Frame = { type: string } & Record<string, unknown>;

let server: Server;
let port: number;
let mounted: MountedSidecar[] = [];
let clientDir: string;

beforeEach(async () => {
  // A stand-in for the built client, so the page route is testable without
  // running vite (the REAL artifact is exercised by the Lab rig).
  clientDir = mkdtempSync(join(tmpdir(), "pencil-client-"));
  writeFileSync(join(clientDir, "index.html"), "<!doctype html><title>pencil client</title>");
  mkdirSync(join(clientDir, "assets"));
  writeFileSync(join(clientDir, "assets", "app.js"), "console.log('client')");

  const app = express();
  const ctx = { log: () => {} };
  mounted = [
    await pencilSidecar({ root: "/proj", clientDir }).mount(app, ctx),
    await barSidecar({ root: "/proj" }).mount(app, ctx),
  ];

  server = createServer(app);
  // The channel's upgrade fan-out: offer each sidecar the socket in turn.
  server.on("upgrade", (req, socket, head) => {
    const taken = mounted.some((m) => m.handleUpgrade?.(req, socket, head));
    if (!taken) {
      socket.destroy();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("no port");
  }
  port = address.port;
});

afterEach(async () => {
  for (const m of mounted) {
    await m.dispose?.();
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(clientDir, { recursive: true, force: true });
});

/** Open a socket and await frames (same helper shape as backend.test.ts). */
function peer(path: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
  const queue: Frame[] = [];
  const waiters: Array<(m: Frame) => void> = [];
  ws.on("message", (data) => {
    let message: Frame | undefined;
    try {
      const parsed: unknown = JSON.parse(data.toString());
      if (parsed && typeof (parsed as Frame).type === "string") {
        message = parsed as Frame;
      }
    } catch {
      // not ours
    }
    if (!message) {
      return;
    }
    const waiter = waiters.shift();
    if (waiter) {
      waiter(message);
    } else {
      queue.push(message);
    }
  });
  const next = (): Promise<Frame> => {
    const queued = queue.shift();
    if (queued) {
      return Promise.resolve(queued);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out")), 2000);
      waiters.push((m) => {
        clearTimeout(timer);
        resolve(m);
      });
    });
  };
  const nextOf = async (type: string): Promise<Frame> => {
    for (let i = 0; i < 10; i++) {
      const m = await next();
      if (m.type === type) {
        return m;
      }
    }
    throw new Error(`no ${type}`);
  };
  return {
    ws,
    nextOf,
    send: (m: Frame) => ws.send(JSON.stringify(m)),
    open: () => new Promise<void>((resolve) => ws.once("open", () => resolve())),
  };
}

describe("the pencil sidecar, on a channel-shaped host", () => {
  it("answers its info route beside the bar's — two sidecars, one app", async () => {
    const pencil = await (await fetch(`http://127.0.0.1:${port}/pencil/info`)).json();
    expect(pencil).toMatchObject({ ok: true, hosts: 0, clients: 0 });
    const bar = await (await fetch(`http://127.0.0.1:${port}/bar/info`)).json();
    expect(bar).toMatchObject({ ok: true });
  });

  it("serves the client page at /pencil/ — the iPad's one HTML route", async () => {
    const page = await fetch(`http://127.0.0.1:${port}/pencil/`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(await page.text()).toContain("pencil client");

    const asset = await fetch(`http://127.0.0.1:${port}/pencil/assets/app.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toContain("javascript");
  });

  it("refuses a traversal out of the client dir", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/pencil/..%2f..%2fetc%2fpasswd`);
    expect([403, 404]).toContain(res.status);
  });

  it("relays ink host↔client through the sidecar's upgrade seam", async () => {
    const host = peer("/pencil/host");
    await host.open();
    const registered = await host.nextOf("registered");
    host.send({ type: "register", label: "seam-test" });

    const client = peer("/pencil/client");
    await client.open();
    await client.nextOf("sessions");
    client.send({ type: "join", host: registered.id as string });
    await client.nextOf("joined");
    await host.nextOf("clientJoined");

    client.send({ type: "scroll", du: 0, dv: 0.5 });
    expect(await host.nextOf("scroll")).toMatchObject({ dv: 0.5 });
    host.ws.close();
    client.ws.close();
  });

  it("relays the bar beside it — the two channels of D5, one port", async () => {
    const host = peer("/bar/host");
    await host.open();
    const registered = await host.nextOf("registered");
    host.send({ type: "register", label: "seam-test" });
    host.send({
      type: "bar",
      rows: [{ command: "x", hint: { key: "x", label: "x" }, lit: false, enabled: true }],
      claims: {},
    });
    await new Promise((r) => setTimeout(r, 50));

    const client = peer("/bar/client");
    await client.open();
    await client.nextOf("sessions");
    client.send({ type: "join", host: registered.id as string });
    await client.nextOf("joined");
    // The join-time replay: an idle host still paints a bar.
    expect(await client.nextOf("bar")).toMatchObject({ type: "bar" });
    host.ws.close();
    client.ws.close();
  });
});
