import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { ChannelResponse } from "./channel";
import { startWebServer, type WebServer } from "./web";

/** Open a client websocket to the server's `/ws` endpoint. */
const connect = (server: WebServer): Promise<WebSocket> =>
  new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });

/** Send one protocol message and await the server's reply to it. */
const roundTrip = (socket: WebSocket, message: unknown): Promise<ChannelResponse> =>
  new Promise((resolve) => {
    socket.once("message", (data) => resolve(JSON.parse(data.toString()) as ChannelResponse));
    socket.send(JSON.stringify(message));
  });

describe("startWebServer", () => {
  let server: WebServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

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

  it("speaks the stream-processor protocol over /ws", async () => {
    const prompts: string[] = [];
    server = await startWebServer({
      onPrompt: (text) => {
        prompts.push(text);
      },
    });

    const socket = await connect(server);
    try {
      expect(await roundTrip(socket, { type: "hello", format: "text-concat" })).toEqual({
        ok: true,
      });

      // Two interleaved threads on one connection.
      await roundTrip(socket, { threadId: "a", payload: { text: "Hello" } });
      await roundTrip(socket, { threadId: "b", payload: { text: "Goodbye" } });
      await roundTrip(socket, { threadId: "a", payload: { text: ", world" } });
      expect(prompts).toEqual([]);

      expect(await roundTrip(socket, { threadId: "a", payload: { done: true } })).toEqual({
        ok: true,
        threadId: "a",
        closed: true,
      });
      expect(prompts).toEqual(["Hello, world"]);

      // The closed thread now rejects messages; the open one still works.
      const rejected = await roundTrip(socket, { threadId: "a", payload: { text: "more" } });
      expect(rejected).toMatchObject({ ok: false, threadId: "a" });
      expect(rejected.error).toContain("closed");

      expect(await roundTrip(socket, { threadId: "b", payload: { done: true } })).toEqual({
        ok: true,
        threadId: "b",
        closed: true,
      });
      expect(prompts).toEqual(["Hello, world", "Goodbye"]);
    } finally {
      socket.close();
    }
  });

  it("keeps concurrent connections' threads independent", async () => {
    const prompts: string[] = [];
    server = await startWebServer({
      onPrompt: (text) => {
        prompts.push(text);
      },
    });

    const [first, second] = await Promise.all([connect(server), connect(server)]);
    try {
      await roundTrip(first, { type: "hello", format: "text-concat" });
      await roundTrip(second, { type: "hello", format: "text-concat" });

      // The same thread id on two connections is two separate threads.
      await roundTrip(first, { threadId: "t", payload: { text: "from first" } });
      await roundTrip(second, { threadId: "t", payload: { text: "from second" } });
      expect(await roundTrip(first, { threadId: "t", payload: { done: true } })).toMatchObject({
        closed: true,
      });
      expect(prompts).toEqual(["from first"]);

      // Closing it on one connection does not close it on the other.
      expect(await roundTrip(second, { threadId: "t", payload: { done: true } })).toMatchObject({
        ok: true,
        closed: true,
      });
      expect(prompts).toEqual(["from first", "from second"]);
    } finally {
      first.close();
      second.close();
    }
  });

  it("closes the socket after a fatal hello error", async () => {
    server = await startWebServer({ onPrompt: () => {} });
    const socket = await connect(server);
    const closed = new Promise<void>((resolve) => {
      socket.once("close", () => resolve());
    });

    const response = await roundTrip(socket, { type: "hello", format: "no-such-format" });
    expect(response).toMatchObject({ ok: false, fatal: true });
    expect(response.error).toContain('unknown format "no-such-format"');
    await closed;
  });
});
