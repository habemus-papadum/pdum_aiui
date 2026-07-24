/**
 * index.test.ts — the generic room core over real websockets, with a trivial
 * message vocabulary. The authoritative behavior oracles are the two consumers'
 * suites (aiui-pencil, aiui-remote-bar); this guards the message-agnostic core in
 * isolation: register broadcasts, join replays the cached slot, and the delegate
 * routes host/client frames.
 */
import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createRoomRelayBackend, type RoomRelayBackend, type RoomServerFrame } from "./index";

// A tiny wire: register + one host-published frame (cached) + one client frame.
type TestWire =
  | { type: "register"; label?: string; name?: string; project?: string; channelPort?: number }
  | { type: "join"; host: string }
  | { type: "leave" }
  | { type: "ping"; value: number } // host → clients, cached for replay
  | { type: "poke"; note: string } // client → host
  | RoomServerFrame;

const encode = (m: TestWire): string => JSON.stringify(m);
const decode = (raw: string): TestWire | undefined => {
  try {
    const value: unknown = JSON.parse(raw);
    if (
      typeof value === "object" &&
      value !== null &&
      typeof (value as TestWire).type === "string"
    ) {
      return value as TestWire;
    }
  } catch {
    // fall through
  }
  return undefined;
};

let server: Server;
let backend: RoomRelayBackend;
let port: number;

beforeEach(async () => {
  backend = createRoomRelayBackend<TestWire>({
    prefix: "/room",
    session: { project: "/proj" },
    logPrefix: "test",
    encode,
    decode,
    onHostMessage(message, { cacheForReplay }) {
      if (message.type === "ping") {
        cacheForReplay(message);
      }
    },
    onClientMessage(message, { sendToHost }) {
      if (message.type === "poke") {
        sendToHost(message);
      }
    },
  });
  server = createServer((req, res) => {
    if (!backend.handleHttp(req, res)) {
      res.statusCode = 404;
      res.end();
    }
  });
  server.on("upgrade", (req, socket, head) => {
    if (!backend.handleUpgrade(req, socket, head)) {
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
  backend.dispose();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

class Peer {
  ws: WebSocket;
  private queue: TestWire[] = [];
  private waiters: Array<(m: TestWire) => void> = [];

  constructor(path: string) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
    this.ws.on("message", (data) => {
      const message = decode(data.toString());
      if (!message) {
        return;
      }
      const waiter = this.waiters.shift();
      if (waiter) {
        waiter(message);
      } else {
        this.queue.push(message);
      }
    });
  }

  next(): Promise<TestWire> {
    const queued = this.queue.shift();
    if (queued) {
      return Promise.resolve(queued);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for a frame")), 2000);
      this.waiters.push((m) => {
        clearTimeout(timer);
        resolve(m);
      });
    });
  }

  async nextOf(type: string): Promise<TestWire> {
    for (let i = 0; i < 10; i++) {
      const m = await this.next();
      if (m.type === type) {
        return m;
      }
    }
    throw new Error(`no ${type} frame arrived`);
  }

  send(message: TestWire): void {
    this.ws.send(encode(message));
  }

  open(): Promise<void> {
    return new Promise((resolve) => this.ws.once("open", () => resolve()));
  }

  close(): void {
    this.ws.close();
  }
}

describe("the room relay core", () => {
  it("broadcasts sessions when a host registers, with the static project attached", async () => {
    const client = new Peer("/room/client");
    await client.open();
    await client.nextOf("sessions");

    const host = new Peer("/room/host");
    await host.open();
    await host.nextOf("registered");
    host.send({ type: "register", label: "app" });

    const update = (await client.nextOf("sessions")) as {
      sessions: Array<{ label: string; project?: string; busy: boolean }>;
    };
    expect(update.sessions).toHaveLength(1);
    expect(update.sessions[0]).toMatchObject({ label: "app", project: "/proj", busy: false });
    host.close();
    client.close();
  });

  it("routes a join, replays the host's cached frame, and forwards a client frame up", async () => {
    const host = new Peer("/room/host");
    await host.open();
    const registered = (await host.nextOf("registered")) as { type: "registered"; id: string };
    host.send({ type: "register", label: "app" });
    host.send({ type: "ping", value: 7 }); // cached with no client yet
    await new Promise((r) => setTimeout(r, 30));

    const client = new Peer("/room/client");
    await client.open();
    await client.nextOf("sessions");
    client.send({ type: "join", host: registered.id });
    await client.nextOf("joined");
    expect(await client.nextOf("ping")).toMatchObject({ value: 7 });
    await host.nextOf("clientJoined");

    client.send({ type: "poke", note: "hi" });
    expect(await host.nextOf("poke")).toMatchObject({ note: "hi" });
    host.close();
    client.close();
  });

  it("carries an announced session name, updates it on re-register, and hands it to joiners", async () => {
    const client = new Peer("/room/client");
    await client.open();
    await client.nextOf("sessions");

    const host = new Peer("/room/host");
    await host.open();
    const registered = (await host.nextOf("registered")) as { type: "registered"; id: string };
    host.send({ type: "register", label: "app", name: "courageous-beaver" });

    const listed = (await client.nextOf("sessions")) as {
      sessions: Array<{ label: string; name?: string }>;
    };
    expect(listed.sessions[0]).toMatchObject({ label: "app", name: "courageous-beaver" });

    // A rename is just a re-register; every listing client hears the new name.
    host.send({ type: "register", label: "app", name: "solemn-otter" });
    const renamed = (await client.nextOf("sessions")) as {
      sessions: Array<{ name?: string }>;
    };
    expect(renamed.sessions[0]).toMatchObject({ name: "solemn-otter" });

    // A blank name is ignored (the last real name stands), and `joined` carries it.
    host.send({ type: "register", label: "app", name: "  " });
    await client.nextOf("sessions");
    client.send({ type: "join", host: registered.id });
    expect(await client.nextOf("joined")).toMatchObject({ name: "solemn-otter" });
    host.close();
    client.close();
  });

  it("records received frames in the ring, collapsing same-shape runs", async () => {
    const host = new Peer("/room/host");
    await host.open();
    await host.nextOf("registered");
    host.send({ type: "register", label: "app" });
    host.send({ type: "ping", value: 1 });
    host.send({ type: "ping", value: 2 });
    host.send({ type: "ping", value: 3 });
    await new Promise((r) => setTimeout(r, 30));

    const res = await fetch(`http://127.0.0.1:${port}/room/frames`);
    const body = (await res.json()) as {
      frames: Array<{ from: string; type: string; n: number }>;
    };
    expect(body.frames.map(({ from, type, n }) => ({ from, type, n }))).toEqual([
      { from: "host-1", type: "register", n: 1 },
      { from: "host-1", type: "ping", n: 3 },
    ]);
    host.close();
  });

  it("rejects a join to a missing host", async () => {
    const client = new Peer("/room/client");
    await client.open();
    await client.nextOf("sessions");
    client.send({ type: "join", host: "host-nope" });
    expect((await client.nextOf("joinRejected")) as { reason: string }).toMatchObject({
      reason: "host not found",
    });
    client.close();
  });

  it("serves info over HTTP with CORS, and 404s off its own routes", async () => {
    const info = await fetch(`http://127.0.0.1:${port}/room/info`);
    expect(info.headers.get("access-control-allow-origin")).toBe("*");
    expect(await info.json()).toMatchObject({ ok: true, hosts: 0, clients: 0 });

    const missing = await fetch(`http://127.0.0.1:${port}/room/nope`);
    expect(missing.status).toBe(404);
  });

  it("enriches the HTTP sessions dump with each host's cached replay frame", async () => {
    const host = new Peer("/room/host");
    await host.open();
    await host.nextOf("registered");
    host.send({ type: "register", label: "app" });
    host.send({ type: "ping", value: 7 });
    await new Promise((r) => setTimeout(r, 30));

    const res = await fetch(`http://127.0.0.1:${port}/room/sessions`);
    const body = (await res.json()) as {
      sessions: Array<{ label: string; replay?: { type: string; value: number } }>;
    };
    expect(body.sessions[0]).toMatchObject({
      label: "app",
      replay: { type: "ping", value: 7 },
    });
    host.close();
  });
});
