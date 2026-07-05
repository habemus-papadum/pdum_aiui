import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { type ChannelClient, connectChannelClient } from "./client";
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
    expect(await health.json()).toMatchObject({ ok: true, pid: process.pid });

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
