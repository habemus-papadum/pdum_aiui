import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { encode, type RelayToClient, type RelayToHost } from "./protocol";
import { type PaintRelay, startPaintRelay } from "./relay";

// A tiny websocket test client that records frames and lets a test await the
// next JSON message matching a predicate (or the next binary frame).
class TestSocket {
  readonly ws: WebSocket;
  private json: Array<Record<string, unknown>> = [];
  private binary: Buffer[] = [];
  private waiters: Array<() => void> = [];

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.on("message", (data: Buffer, isBinary: boolean) => {
      if (isBinary) {
        this.binary.push(data);
      } else {
        this.json.push(JSON.parse(data.toString()));
      }
      for (const w of this.waiters.splice(0)) {
        w();
      }
    });
  }

  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws.once("open", () => resolve());
      this.ws.once("error", reject);
    });
  }

  sendJson(message: unknown): void {
    this.ws.send(JSON.stringify(message));
  }

  async nextJson<T extends Record<string, unknown>>(
    pred: (m: Record<string, unknown>) => boolean,
    timeoutMs = 1000,
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const idx = this.json.findIndex(pred);
      if (idx >= 0) {
        return this.json.splice(idx, 1)[0] as T;
      }
      if (Date.now() > deadline) {
        throw new Error(`timed out; saw ${JSON.stringify(this.json)}`);
      }
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        setTimeout(resolve, 25);
      });
    }
  }

  /** Whether any currently-buffered JSON frame matches (does not consume). */
  hasJson(pred: (m: Record<string, unknown>) => boolean): boolean {
    return this.json.some(pred);
  }

  async nextBinary(timeoutMs = 1000): Promise<Buffer> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (this.binary.length > 0) {
        return this.binary.shift() as Buffer;
      }
      if (Date.now() > deadline) {
        throw new Error("timed out waiting for a binary frame");
      }
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        setTimeout(resolve, 25);
      });
    }
  }

  close(): void {
    this.ws.close();
  }
}

let relay: PaintRelay | undefined;
const sockets: TestSocket[] = [];

afterEach(async () => {
  for (const s of sockets.splice(0)) {
    s.close();
  }
  await relay?.close();
  relay = undefined;
});

const startRelay = async (): Promise<PaintRelay> => {
  relay = await startPaintRelay({
    host: "127.0.0.1",
    port: 0,
    serveClient: false,
    resolveChannel: (port) =>
      port === 9999 ? { tag: "demo-tag", project: "/tmp/demo-project" } : undefined,
  });
  return relay;
};

const connect = async (path: string): Promise<TestSocket> => {
  const s = new TestSocket(`ws://127.0.0.1:${relay?.port}${path}`);
  sockets.push(s);
  await s.open();
  return s;
};

// Register a host and wait until it is announced.
const registerHost = async (
  register: Record<string, unknown> = { type: "register", label: "app" },
): Promise<TestSocket> => {
  const host = await connect("/host");
  await host.nextJson<RelayToHost & Record<string, unknown>>((m) => m.type === "registered");
  host.sendJson(register);
  return host;
};

describe("paint relay", () => {
  it("advertises a registered host to a later client", async () => {
    await startRelay();
    await registerHost({ type: "register", label: "my app", channelPort: 9999 });

    const client = await connect("/client");
    const sessions = await client.nextJson<{ sessions: Array<Record<string, unknown>> }>(
      (m) => m.type === "sessions" && Array.isArray(m.sessions) && m.sessions.length === 1,
    );
    expect(sessions.sessions[0]).toMatchObject({
      label: "my app",
      channelTag: "demo-tag",
      project: "/tmp/demo-project",
      busy: false,
    });
    expect(relay?.sessions()).toHaveLength(1);
  });

  it("routes a join, forwards intents, and marks the host busy", async () => {
    await startRelay();
    const host = await registerHost();
    const client = await connect("/client");
    const sessions = await client.nextJson<{ sessions: Array<{ id: string }> }>(
      (m) => m.type === "sessions" && (m.sessions as unknown[]).length === 1,
    );
    const hostId = sessions.sessions[0].id;

    client.sendJson({ type: "join", host: hostId });
    await client.nextJson((m) => m.type === "joined" && m.host === hostId);
    await host.nextJson((m) => m.type === "clientJoined");
    // The host now shows as busy in a fresh sessions broadcast.
    await client.nextJson(
      (m) => m.type === "sessions" && (m.sessions as Array<{ busy: boolean }>)[0].busy === true,
    );

    client.sendJson({
      type: "strokeBegin",
      id: "s1",
      pointerType: "pen",
      style: { color: "#f00", width: 4 },
      point: { u: 0.5, v: 0.5 },
    });
    const stroke = await host.nextJson((m) => m.type === "strokeBegin");
    expect(stroke).toMatchObject({ id: "s1", style: { color: "#f00", width: 4 } });
  });

  it("broadcasts host video frames and view-state to the client", async () => {
    await startRelay();
    const host = await registerHost();
    const client = await connect("/client");
    const { sessions } = await client.nextJson<{ sessions: Array<{ id: string }> }>(
      (m) => m.type === "sessions" && (m.sessions as unknown[]).length === 1,
    );
    client.sendJson({ type: "join", host: sessions[0].id });
    await host.nextJson((m) => m.type === "clientJoined");

    host.ws.send(Buffer.from([1, 2, 3, 4]), { binary: true });
    expect([...(await client.nextBinary())]).toEqual([1, 2, 3, 4]);

    host.ws.send(
      encode({
        type: "viewState",
        armed: true,
        viewportWidth: 800,
        viewportHeight: 600,
        scrollX: 0,
        scrollY: 120,
        scrollWidth: 800,
        scrollHeight: 2000,
        documentZoom: 1,
      }),
    );
    const view = await client.nextJson<RelayToClient & Record<string, unknown>>(
      (m) => m.type === "viewState",
    );
    expect(view).toMatchObject({ armed: true, scrollY: 120 });
  });

  it("tells the client when the host disconnects", async () => {
    await startRelay();
    const host = await registerHost();
    const client = await connect("/client");
    const { sessions } = await client.nextJson<{ sessions: Array<{ id: string }> }>(
      (m) => m.type === "sessions" && (m.sessions as unknown[]).length === 1,
    );
    client.sendJson({ type: "join", host: sessions[0].id });
    await client.nextJson((m) => m.type === "joined");

    host.close();
    await client.nextJson((m) => m.type === "hostGone");
    await client.nextJson((m) => m.type === "sessions" && (m.sessions as unknown[]).length === 0);
  });

  it("rejects a join to a missing host", async () => {
    await startRelay();
    const client = await connect("/client");
    await client.nextJson((m) => m.type === "sessions");
    client.sendJson({ type: "join", host: "host-nope" });
    const rejected = await client.nextJson((m) => m.type === "joinRejected");
    expect(rejected.reason).toBe("host not found");
  });

  it("carries a client id on clientJoined/clientLeft", async () => {
    await startRelay();
    const host = await registerHost();
    const client = await connect("/client");
    const { sessions } = await client.nextJson<{ sessions: Array<{ id: string }> }>(
      (m) => m.type === "sessions" && (m.sessions as unknown[]).length === 1,
    );
    client.sendJson({ type: "join", host: sessions[0].id });
    const joined = await host.nextJson((m) => m.type === "clientJoined");
    expect(typeof joined.client).toBe("string");

    client.sendJson({ type: "leave" });
    const left = await host.nextJson((m) => m.type === "clientLeft");
    expect(left.client).toBe(joined.client);
  });

  it("routes WebRTC signaling to the addressed viewer only", async () => {
    await startRelay();
    const host = await registerHost();
    const a = await connect("/client");
    const b = await connect("/client");
    const list = await a.nextJson<{ sessions: Array<{ id: string }> }>(
      (m) => m.type === "sessions" && (m.sessions as unknown[]).length === 1,
    );
    a.sendJson({ type: "join", host: list.sessions[0].id });
    b.sendJson({ type: "join", host: list.sessions[0].id });
    await host.nextJson((m) => m.type === "clientJoined");
    await host.nextJson((m) => m.type === "clientJoined");

    // A sends an SDP offer (no peer); the relay stamps A's id and hands it to the host.
    a.sendJson({ type: "signal", data: { description: { type: "offer", sdp: "A" } } });
    const relayed = await host.nextJson((m) => m.type === "signal");
    expect(typeof relayed.peer).toBe("string");
    expect(relayed.data).toEqual({ description: { type: "offer", sdp: "A" } });

    // The host answers that specific peer; only A receives it (peer stripped).
    host.sendJson({
      type: "signal",
      peer: relayed.peer,
      data: { description: { type: "answer" } },
    });
    const answer = await a.nextJson((m) => m.type === "signal");
    expect(answer.data).toEqual({ description: { type: "answer" } });
    expect(answer.peer).toBeUndefined();

    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(b.hasJson((m) => m.type === "signal")).toBe(false);
  });

  it("serves the iPad client and the HTTP endpoints", async () => {
    relay = await startPaintRelay({ host: "127.0.0.1", port: 0 });
    const base = `http://127.0.0.1:${relay.port}`;

    const page = await fetch(`${base}/`);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(await page.text()).toContain("aiui paint");

    expect(await (await fetch(`${base}/health`)).json()).toMatchObject({ ok: true });
    expect(await (await fetch(`${base}/sessions`)).json()).toEqual({ sessions: [] });
  });
});
