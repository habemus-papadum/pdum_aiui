import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import type { ChannelFormat, ChannelResponse } from "./channel";
import { type ChannelClient, connectChannelClient } from "./client";
import { jsonCodec } from "./codec";
import { encodeFrame, PROTOCOL_VERSION } from "./frame";
import { defaultFormats } from "./processors";
import { startWebServer, type WebServer } from "./web";

describe("startWebServer", () => {
  let server: WebServer | undefined;
  const clients: ChannelClient[] = [];

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((c) => c.close()));
    await server?.close();
    server = undefined;
  });

  const connect = async (format = "text-concat"): Promise<ChannelClient> => {
    if (!server) {
      throw new Error("server not started");
    }
    const client = await connectChannelClient({
      url: `ws://127.0.0.1:${server.port}/ws`,
      format,
    });
    clients.push(client);
    return client;
  };

  it("serves health, forwards prompts, and rejects empty ones", async () => {
    const received: string[] = [];
    server = await startWebServer({
      onPrompt: (text) => {
        received.push(text);
      },
    });
    expect(server.port).toBeGreaterThan(0);
    const base = `http://127.0.0.1:${server.port}`;

    const health = await fetch(`${base}/health`);
    expect(health.status).toBe(200);
    // host reports the bound address (loopback unless the launcher widens it) —
    // the console dashboard reads it to decide which URLs an iPad could open.
    expect(await health.json()).toMatchObject({
      ok: true,
      pid: process.pid,
      host: "127.0.0.1",
    });

    const ok = await fetch(`${base}/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hello session" }),
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true });
    expect(received).toEqual(["hello session"]);

    const bad = await fetch(`${base}/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(bad.status).toBe(400);
  });

  it("forwards traceSink — recorded trace stages reach the sink live", async () => {
    const cache = mkdtempSync(join(tmpdir(), "aiui-web-trace-"));
    const stages: string[] = [];
    server = await startWebServer({
      onPrompt: () => {},
      traceDir: cache,
      traceSink: (event) => stages.push(event.stage.label),
    });
    const client = await connect("text-concat");
    await client.openThread("t-trace").finish({ text: "hello" });
    await client.close();

    // A traced run records at least its client context + the lowered output; the
    // sink sees them as they happen (this is the seam `serve` narrates from).
    for (let i = 0; i < 40 && stages.length === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(stages.length).toBeGreaterThan(0);
  });

  it("propagates handler errors as a 500", async () => {
    server = await startWebServer({
      onPrompt: () => {
        throw new Error("boom");
      },
    });
    const res = await fetch(`http://127.0.0.1:${server.port}/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "x" }),
    });
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ ok: false, error: "boom" });
  });

  it("speaks the binary stream-processor protocol over /ws", async () => {
    const prompts: string[] = [];
    server = await startWebServer({
      onPrompt: (text) => {
        prompts.push(text);
      },
    });
    const client = await connect();

    // Two interleaved threads on one connection.
    const a = client.openThread("a");
    const b = client.openThread("b");
    await a.send({ text: "Hello" });
    await b.send({ text: "Goodbye" });
    await a.send({ text: ", world" });
    expect(prompts).toEqual([]);

    expect(await a.finish()).toMatchObject({ ok: true, threadId: "a", closed: true });
    expect(prompts).toEqual(["Hello, world"]);

    // The closed thread now rejects frames; the open one still works.
    const rejected = await a.send({ text: "more" });
    expect(rejected).toMatchObject({ ok: false, threadId: "a" });
    expect(rejected.error).toContain("closed");

    expect(await b.finish()).toMatchObject({ ok: true, threadId: "b", closed: true });
    expect(prompts).toEqual(["Hello, world", "Goodbye"]);
  });

  it("keeps concurrent connections' threads independent", async () => {
    const prompts: string[] = [];
    server = await startWebServer({
      onPrompt: (text) => {
        prompts.push(text);
      },
    });
    const [first, second] = await Promise.all([connect(), connect()]);

    // The same thread id on two connections is two separate threads.
    await first.openThread("t").send({ text: "from first" });
    const secondThread = second.openThread("t");
    await secondThread.send({ text: "from second" });
    expect(await first.openThread("t").finish()).toMatchObject({ closed: true });
    expect(prompts).toEqual(["from first"]);

    expect(await secondThread.finish()).toMatchObject({ ok: true, closed: true });
    expect(prompts).toEqual(["from first", "from second"]);
  });

  it("fatally rejects a non-binary frame and closes the socket", async () => {
    server = await startWebServer({ onPrompt: () => {} });
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));

    const ack = await new Promise<{ ok: boolean; fatal?: boolean; error?: string }>((resolve) => {
      socket.once("message", (data) => resolve(JSON.parse(data.toString())));
      socket.send("this is a text frame, not binary");
    });
    expect(ack).toMatchObject({ ok: false, fatal: true });
    expect(ack.error).toContain("binary");
    await closed;
  });
});

describe("startWebServer debug mode", () => {
  let server: WebServer | undefined;
  const openSockets: WebSocket[] = [];

  afterEach(async () => {
    for (const ws of openSockets.splice(0)) {
      ws.close();
    }
    await server?.close();
    server = undefined;
  });

  /** Send a hello over a raw socket and return its ack verbatim. */
  async function helloAck(port: number): Promise<ChannelResponse> {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    openSockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
    return new Promise((resolve) => {
      socket.once("message", (data) => resolve(JSON.parse(data.toString())));
      socket.send(encodeFrame({ v: PROTOCOL_VERSION, kind: "hello", format: "text-concat" }));
    });
  }

  it("advertises debug on /health and on the hello ack (never with a kind field)", async () => {
    server = await startWebServer({ onPrompt: () => {}, debug: true });

    const health = (await (await fetch(`http://127.0.0.1:${server.port}/health`)).json()) as {
      debug?: boolean;
    };
    expect(health.debug).toBe(true);

    const ack = await helloAck(server.port);
    expect(ack).toEqual({ ok: true, debug: true });
    // The ack/push discriminator: acks never carry `kind` (clients rely on it).
    expect("kind" in ack).toBe(false);
  });

  it("stays silent about debug when the server is not in debug mode", async () => {
    server = await startWebServer({ onPrompt: () => {} });
    const health = (await (await fetch(`http://127.0.0.1:${server.port}/health`)).json()) as {
      debug?: boolean;
    };
    expect(health.debug).toBeUndefined();
    expect(await helloAck(server.port)).toEqual({ ok: true });
  });
});

describe("startWebServer page tools (/tools websocket end to end)", () => {
  let server: WebServer | undefined;
  const openSockets: WebSocket[] = [];
  const NO_REPLY = Symbol("no-reply");

  afterEach(async () => {
    for (const ws of openSockets.splice(0)) {
      ws.close();
    }
    await server?.close();
    server = undefined;
  });

  /** A raw `/tools` client that registers tool sets and answers routed calls (as the bridge would). */
  async function openPage(handlers: Record<string, (args: unknown) => unknown> = {}) {
    if (!server) {
      throw new Error("server not started");
    }
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/tools`);
    openSockets.push(ws);
    const opened = new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    const registeredWaiters: Array<() => void> = [];
    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === "registered") {
        registeredWaiters.shift()?.();
      } else if (msg.type === "call") {
        const fn = handlers[msg.name];
        try {
          const value = fn ? fn(msg.args) : null;
          if (value === NO_REPLY) {
            return;
          }
          ws.send(JSON.stringify({ v: 1, type: "result", callId: msg.callId, ok: true, value }));
        } catch (err) {
          ws.send(
            JSON.stringify({
              v: 1,
              type: "result",
              callId: msg.callId,
              ok: false,
              error: (err as Error).message,
            }),
          );
        }
      }
    });
    await opened;
    const register = async (ns: string, tools: unknown[], hash = "h1") => {
      const acked = new Promise<void>((resolve) => registeredWaiters.push(resolve));
      ws.send(
        JSON.stringify({ v: 1, type: "register", ns, url: `http://localhost/${ns}`, hash, tools }),
      );
      await acked;
    };
    return { ws, register };
  }

  it("round-trips a value and an error through the directory", async () => {
    server = await startWebServer({ onPrompt: () => {} });
    const page = await openPage({
      greet: (args) => ({ hi: (args as { name: string }).name }),
      boom: () => {
        throw new Error("kaboom");
      },
    });
    await page.register("morpho", [
      { name: "greet", description: "greet" },
      { name: "boom", description: "explode" },
    ]);

    expect(server.pageTools.list()).toMatchObject([
      { ns: "morpho", url: "http://localhost/morpho" },
    ]);
    await expect(server.pageTools.call({ name: "greet", args: { name: "ada" } })).resolves.toEqual({
      hi: "ada",
    });
    await expect(server.pageTools.call({ name: "boom" })).rejects.toThrow("kaboom");
  });

  it("times out when the page never answers", async () => {
    server = await startWebServer({ onPrompt: () => {} });
    const page = await openPage({ hang: () => NO_REPLY });
    await page.register("morpho", [{ name: "hang", description: "never returns" }]);
    await expect(server.pageTools.call({ name: "hang", timeoutMs: 40 })).rejects.toThrow(
      /timed out/,
    );
  });

  it("drops registrations and rejects in-flight calls when a page disconnects", async () => {
    server = await startWebServer({ onPrompt: () => {} });
    const page = await openPage({ hang: () => NO_REPLY });
    await page.register("morpho", [{ name: "hang", description: "never returns" }]);
    expect(server.pageTools.list()).toHaveLength(1);

    const pending = server.pageTools.call({ name: "hang", timeoutMs: 2000 });
    page.ws.close();
    await expect(pending).rejects.toThrow(/disconnected/);
    // The directory ages the connection out once the socket close is observed.
    await vi.waitFor(() => expect(server?.pageTools.list()).toHaveLength(0));
  });

  it("reports ambiguity across two pages and disambiguates by ns", async () => {
    server = await startWebServer({ onPrompt: () => {} });
    const a = await openPage({ report: () => "morpho-report" });
    await a.register("morpho", [{ name: "report", description: "snapshot" }]);
    const b = await openPage({ report: () => "aztec-report" });
    await b.register("aztec", [{ name: "report", description: "snapshot" }]);

    await expect(server.pageTools.call({ name: "report" })).rejects.toThrow(/ambiguous/);
    await expect(server.pageTools.call({ name: "report", ns: "morpho" })).resolves.toBe(
      "morpho-report",
    );
    await expect(server.pageTools.call({ name: "report", ns: "aztec" })).resolves.toBe(
      "aztec-report",
    );
  });
});

/**
 * A tools client that behaves like the intent client's tools-link across a drop:
 * re-dials after a short delay and re-registers its namespace on every (re)open.
 * We keep the delay tiny so the reconnect test never sleeps for the real 3s.
 */
function reconnectingPage(port: number, ns: string, tools: unknown[], reconnectMs: number) {
  let ws: WebSocket | undefined;
  let disposed = false;
  let registerCount = 0;
  const dial = (): void => {
    ws = new WebSocket(`ws://127.0.0.1:${port}/tools`);
    ws.on("open", () => {
      ws?.send(
        JSON.stringify({
          v: 1,
          type: "register",
          ns,
          url: `http://localhost/${ns}`,
          hash: "h1",
          tools,
        }),
      );
    });
    ws.on("message", (data) => {
      if (JSON.parse(data.toString()).type === "registered") {
        registerCount += 1;
      }
    });
    ws.on("close", () => {
      if (!disposed) {
        setTimeout(dial, reconnectMs);
      }
    });
    ws.on("error", () => {});
  };
  dial();
  return {
    get registerCount() {
      return registerCount;
    },
    dispose(): void {
      disposed = true;
      ws?.close();
    },
  };
}

describe("startWebServer reload (hot-reload the lowering layer in place)", () => {
  let server: WebServer | undefined;
  const clients: ChannelClient[] = [];
  const disposers: Array<() => void> = [];

  afterEach(async () => {
    for (const dispose of disposers.splice(0)) {
      dispose();
    }
    await Promise.all(clients.splice(0).map((c) => c.close().catch(() => {})));
    await server?.close();
    server = undefined;
  });

  const connect = async (port: number, format: string): Promise<ChannelClient> => {
    const client = await connectChannelClient({ url: `ws://127.0.0.1:${port}/ws`, format });
    clients.push(client);
    return client;
  };

  /** A text format whose lowered prompt carries its generation, to prove the swap. */
  const stampFormat = (gen: number): ChannelFormat => ({
    codec: jsonCodec,
    createProcessor: (ctx) => ({
      async onMessage(payload, meta) {
        if (meta.fin) {
          await ctx.sendPrompt(`gen${gen}: ${(payload as { text?: string })?.text ?? ""}`);
          ctx.close();
        }
      },
    }),
  });

  it("rebuilds the registry so a connection opened after reload speaks the new layer", async () => {
    const prompts: string[] = [];
    server = await startWebServer({
      onPrompt: (t) => {
        prompts.push(t);
      },
      loadFormats: (gen) => new Map([["text-concat", stampFormat(gen)]]),
    });
    await (await connect(server.port, "text-concat")).openThread("a").finish({ text: "hi" });
    expect(prompts).toEqual(["gen0: hi"]);

    const summary = await server.reload();
    expect(summary).toMatchObject({ reloaded: true, generation: 1 });

    // A connection opened after the reload lowers through the gen-1 format.
    await (await connect(server.port, "text-concat")).openThread("b").finish({ text: "hi" });
    expect(prompts).toEqual(["gen0: hi", "gen1: hi"]);
  });

  it("drops live sockets on reload and runs each thread's onClose teardown", async () => {
    const torndown: string[] = [];
    const probeFormat: ChannelFormat = {
      codec: jsonCodec,
      createProcessor: (ctx) => ({
        onMessage() {
          // Keep the thread open — never fin, never self-close.
        },
        onClose() {
          torndown.push(ctx.threadId);
        },
      }),
    };
    server = await startWebServer({
      onPrompt: () => {},
      loadFormats: () => new Map([["probe", probeFormat]]),
    });
    const client = await connect(server.port, "probe");
    await client.openThread("t1").send({}); // materialize the processor, mid-turn

    const summary = await server.reload();
    expect(summary.socketsDropped).toBe(1);
    // The dropped socket runs the abandoned-thread teardown path.
    await vi.waitFor(() => expect(torndown).toEqual(["t1"]));
  });

  it("is a no-op beyond the generation bump with no connections, and survives a double reload", async () => {
    server = await startWebServer({ onPrompt: () => {}, loadFormats: () => defaultFormats() });
    expect(await server.reload()).toEqual({ reloaded: true, generation: 1, socketsDropped: 0 });
    expect(await server.reload()).toEqual({ reloaded: true, generation: 2, socketsDropped: 0 });
    expect(server.getGeneration()).toBe(2);
  });

  it("rejects and leaves the running server untouched when the fresh layer fails to load", async () => {
    let broken = false;
    server = await startWebServer({
      onPrompt: () => {},
      loadFormats: () => {
        if (broken) {
          throw new Error("bad edit");
        }
        return defaultFormats();
      },
    });
    broken = true;
    await expect(server.reload()).rejects.toThrow("bad edit");
    expect(server.getGeneration()).toBe(0); // generation not bumped on failure

    // The old layer is still live: a fresh connection still lowers a prompt.
    const ack = await (await connect(server.port, "text-concat"))
      .openThread("a")
      .finish({ text: "alive" });
    expect(ack).toMatchObject({ ok: true, closed: true });
  });

  it("reloads via POST /debug/api/reload and reflects the generation on /debug/api/info and /health", async () => {
    const cache = mkdtempSync(join(tmpdir(), "aiui-reload-"));
    server = await startWebServer({
      onPrompt: () => {},
      traceDir: cache,
      loadFormats: () => defaultFormats(),
    });
    const base = `http://127.0.0.1:${server.port}`;

    const res = await fetch(`${base}/debug/api/reload`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ reloaded: true, generation: 1, socketsDropped: 0 });

    const info = (await (await fetch(`${base}/debug/api/info`)).json()) as { generation?: number };
    expect(info.generation).toBe(1);
    const health = (await (await fetch(`${base}/health`)).json()) as { generation?: number };
    expect(health.generation).toBe(1);
  });

  it("end to end: a reconnecting tools client re-registers after a reload drops its socket", async () => {
    server = await startWebServer({ onPrompt: () => {}, loadFormats: () => defaultFormats() });
    const page = reconnectingPage(
      server.port,
      "morpho",
      [{ name: "report", description: "snap" }],
      20,
    );
    disposers.push(() => page.dispose());

    // The first registration lands.
    await vi.waitFor(() => expect(server?.pageTools.list()).toHaveLength(1));
    const before = page.registerCount;

    const summary = await server.reload();
    expect(summary.socketsDropped).toBeGreaterThanOrEqual(1); // the live socket was dropped

    // The bridge-style client reconnects on its own and re-registers — a fresh
    // register (registerCount climbs), leaving the directory repopulated. (The
    // brief emptied state between drop and reconnect is real but too transient to
    // assert without racing the ~20ms reconnect; the rising count proves the round trip.)
    await vi.waitFor(
      () => {
        expect(page.registerCount).toBeGreaterThan(before);
        expect(server?.pageTools.list()).toHaveLength(1);
      },
      { timeout: 2000 },
    );
  });
});

describe("startWebServer session bus HTTP surface (/session/peers + /session/publish)", () => {
  let server: WebServer | undefined;
  const openSockets: WebSocket[] = [];

  afterEach(async () => {
    for (const ws of openSockets.splice(0)) {
      ws.close();
    }
    await server?.close();
    server = undefined;
  });

  /** A raw `/session` view: greets with `hello`, records every hub push. */
  async function openView(hello: Record<string, unknown>) {
    if (!server) {
      throw new Error("server not started");
    }
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/session`);
    openSockets.push(ws);
    const received: Array<Record<string, unknown>> = [];
    ws.on("message", (data) => received.push(JSON.parse(data.toString())));
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    ws.send(JSON.stringify({ v: 1, type: "hello", ...hello }));
    // The snapshot reply names this connection — the id external callers target.
    await vi.waitFor(() => expect(received.some((m) => m.type === "snapshot")).toBe(true));
    const snapshot = received.find((m) => m.type === "snapshot") as { clientId: string };
    return { ws, received, clientId: snapshot.clientId };
  }

  it("lists peers and delivers a targeted server publish end to end", async () => {
    server = await startWebServer({ onPrompt: () => {} });
    const base = `http://127.0.0.1:${server.port}`;

    // Nothing connected yet: an empty peer list, and a publish has nobody to reach.
    expect(await (await fetch(`${base}/session/peers`)).json()).toEqual({
      ok: true,
      peers: [],
      armed: false,
    });

    const app = await openView({ role: "app", label: "Demo", url: "http://localhost:5173/" });
    const peers = await (await fetch(`${base}/session/peers`)).json();
    expect(peers.peers).toEqual([
      { clientId: app.clientId, role: "app", label: "Demo", url: "http://localhost:5173/" },
    ]);

    // The cached `armed` slot rides along on both routes.
    app.ws.send(JSON.stringify({ v: 1, type: "set", slot: "armed", value: true }));
    await vi.waitFor(async () => {
      expect((await (await fetch(`${base}/session/peers`)).json()).armed).toBe(true);
    });

    const payload = { kind: "selection", text: "const x = 1;", sourceLoc: "src/a.ts:1:1" };
    const res = await fetch(`${base}/session/publish`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientId: app.clientId, topic: "contribution", payload }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      delivered: [
        { clientId: app.clientId, role: "app", label: "Demo", url: "http://localhost:5173/" },
      ],
      armed: true,
    });
    await vi.waitFor(() => expect(app.received.some((m) => m.type === "publish")).toBe(true));
    expect(app.received.find((m) => m.type === "publish")).toEqual({
      v: 1,
      type: "publish",
      topic: "contribution",
      payload,
      from: "server",
    });
  });

  it("nacks a publish nobody matches and rejects a missing topic", async () => {
    server = await startWebServer({ onPrompt: () => {} });
    const base = `http://127.0.0.1:${server.port}`;
    const app = await openView({ role: "app" });

    const missing = await fetch(`${base}/session/publish`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientId: "nope", topic: "contribution", payload: {} }),
    });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({
      ok: false,
      error: expect.stringContaining("nope"),
    });

    const wrongRole = await fetch(`${base}/session/publish`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role: "git", topic: "contribution" }),
    });
    expect(wrongRole.status).toBe(404);

    const noTopic = await fetch(`${base}/session/publish`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientId: app.clientId }),
    });
    expect(noTopic.status).toBe(400);

    // None of the misses leaked anything to the connected view.
    expect(app.received.filter((m) => m.type === "publish")).toHaveLength(0);
  });
});
