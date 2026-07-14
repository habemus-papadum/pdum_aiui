import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { type BarBackend, type BarBackendOptions, createBarBackend } from "./backend";
import type { RelayToHost } from "./protocol";

/**
 * The kind of host a real deployment provides (the channel sidecar, a bespoke
 * Express server), reduced to its essentials: forward requests + upgrades to the
 * backend, destroy what nothing claims. Mirrors aiui-paint/backend.test.ts.
 */
interface Harness {
  backend: BarBackend;
  port: number;
  close: () => Promise<void>;
}

async function startHarness(options: BarBackendOptions = {}): Promise<Harness> {
  const backend = createBarBackend(options);
  const server: Server = createServer((req, res) => {
    if (!backend.handleHttp(req, res)) {
      res.statusCode = 404;
      res.end("not found");
    }
  });
  server.on("upgrade", (req, socket, head) => {
    if (!backend.handleUpgrade(req, socket, head)) {
      socket.destroy();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    backend,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        backend.dispose();
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

// A tiny websocket test client that records frames and lets a test await the
// next message matching a predicate.
class TestSocket {
  readonly ws: WebSocket;
  private json: Array<Record<string, unknown>> = [];
  private waiters: Array<() => void> = [];

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.on("message", (data: Buffer) => {
      this.json.push(JSON.parse(data.toString()));
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

  /** Whether any currently-buffered frame matches (does not consume). */
  hasJson(pred: (m: Record<string, unknown>) => boolean): boolean {
    return this.json.some(pred);
  }

  close(): void {
    this.ws.close();
  }
}

let harness: Harness | undefined;
const sockets: TestSocket[] = [];

afterEach(async () => {
  for (const s of sockets.splice(0)) {
    s.close();
  }
  await harness?.close();
  harness = undefined;
});

const startRelay = async (): Promise<Harness> => {
  harness = await startHarness({
    resolveChannel: (port) =>
      port === 9999 ? { tag: "demo-tag", project: "/tmp/demo-project" } : undefined,
  });
  return harness;
};

const connect = async (path: string): Promise<TestSocket> => {
  const s = new TestSocket(`ws://127.0.0.1:${harness?.port}${path}`);
  sockets.push(s);
  await s.open();
  return s;
};

const registerHost = async (
  register: Record<string, unknown> = { type: "register", label: "app" },
): Promise<TestSocket> => {
  const host = await connect("/host");
  await host.nextJson<RelayToHost & Record<string, unknown>>((m) => m.type === "registered");
  host.sendJson(register);
  return host;
};

describe("bar backend (relay semantics)", () => {
  it("advertises a registered host to a later client, enriched via channelPort", async () => {
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
    expect(harness?.backend.sessions()).toHaveLength(1);
  });

  it("routes a join, forwards bar down and command up, and marks the host busy", async () => {
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
    await client.nextJson(
      (m) => m.type === "sessions" && (m.sessions as Array<{ busy: boolean }>)[0].busy === true,
    );

    // Bar down: host → client.
    host.sendJson({
      type: "bar",
      rows: [{ command: "ink", hint: { key: "i", label: "ink" }, lit: true, enabled: true }],
      claims: { ring: "active" },
      phase: "turn",
    });
    const bar = await client.nextJson((m) => m.type === "bar");
    expect(bar).toMatchObject({ phase: "turn", claims: { ring: "active" } });

    // Command up: client → host.
    client.sendJson({ type: "command", command: "ink", payload: { on: true } });
    const command = await host.nextJson((m) => m.type === "command");
    expect(command).toMatchObject({ command: "ink", payload: { on: true } });
  });

  it("replays the host's last bar to a client that joins an idle host", async () => {
    await startRelay();
    const host = await registerHost();
    // The host publishes a bar with NO client connected yet…
    host.sendJson({
      type: "bar",
      rows: [{ command: "send", hint: { key: "↵", label: "send" }, lit: false, enabled: true }],
      claims: {},
      phase: "armed",
    });

    // …then a client joins and must still see that bar, with no further commit.
    const client = await connect("/client");
    const { sessions } = await client.nextJson<{ sessions: Array<{ id: string }> }>(
      (m) => m.type === "sessions" && (m.sessions as unknown[]).length === 1,
    );
    client.sendJson({ type: "join", host: sessions[0].id });
    await client.nextJson((m) => m.type === "joined");
    const replayed = await client.nextJson((m) => m.type === "bar");
    expect(replayed).toMatchObject({ phase: "armed" });
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

  it("carries a client id on clientJoined/clientLeft and clears busy on leave", async () => {
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
    await client.nextJson(
      (m) => m.type === "sessions" && (m.sessions as Array<{ busy: boolean }>)[0].busy === false,
    );
  });

  it("does not forward a command from a client that has not joined", async () => {
    await startRelay();
    const host = await registerHost();
    const client = await connect("/client");
    await client.nextJson((m) => m.type === "sessions");

    client.sendJson({ type: "command", command: "ink" });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(host.hasJson((m) => m.type === "command")).toBe(false);
  });

  it("serves the JSON HTTP endpoints", async () => {
    harness = await startHarness();
    const base = `http://127.0.0.1:${harness.port}`;

    const info = await fetch(`${base}/info`);
    expect(info.headers.get("access-control-allow-origin")).toBe("*");
    expect(await info.json()).toMatchObject({ ok: true, hosts: 0, clients: 0 });

    expect(await (await fetch(`${base}/health`)).json()).toMatchObject({ ok: true });
    expect(await (await fetch(`${base}/sessions`)).json()).toEqual({ sessions: [] });
  });

  it("mounts under a prefix — endpoints and upgrades move together", async () => {
    harness = await startHarness({ prefix: "/bar" });
    const base = `http://127.0.0.1:${harness.port}`;

    expect((await fetch(`${base}/bar/info`)).status).toBe(200);
    expect((await fetch(`${base}/info`)).status).toBe(404); // nothing at the root
    expect(await (await fetch(`${base}/bar/sessions`)).json()).toEqual({ sessions: [] });

    const host = await connect("/bar/host");
    await host.nextJson((m) => m.type === "registered");
    host.sendJson({ type: "register", label: "prefixed app" });
    const client = await connect("/bar/client");
    const sessions = await client.nextJson<{ sessions: Array<Record<string, unknown>> }>(
      (m) => m.type === "sessions" && (m.sessions as unknown[]).length === 1,
    );
    expect(sessions.sessions[0]).toMatchObject({ label: "prefixed app" });
  });

  it("inherits the static session identity when a host doesn't announce its own", async () => {
    harness = await startHarness({ session: { project: "/proj/demo", channelTag: "tag-1" } });
    await registerHost({ type: "register", label: "app" });
    const client = await connect("/client");
    const sessions = await client.nextJson<{ sessions: Array<Record<string, unknown>> }>(
      (m) => m.type === "sessions" && (m.sessions as unknown[]).length === 1,
    );
    expect(sessions.sessions[0]).toMatchObject({ project: "/proj/demo", channelTag: "tag-1" });
  });

  it("declines a malformed request-target instead of throwing", async () => {
    harness = await startHarness();
    const req = { url: "//[", method: "GET" } as never;
    expect(harness.backend.handleHttp(req, {} as never)).toBe(false);
    const socket = { destroy: () => {} } as never;
    expect(harness.backend.handleUpgrade({ url: "//[" } as never, socket, Buffer.alloc(0))).toBe(
      false,
    );
  });
});
