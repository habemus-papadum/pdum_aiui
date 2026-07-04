import { describe, expect, it } from "vitest";
import {
  type ChannelConnection,
  createChannelConnection,
  type StreamProcessorFactory,
} from "./channel";

/** A factory that records every (threadId, payload) it sees. */
const recordingFactory = (
  seen: Array<{ threadId: string; payload: unknown }>,
): StreamProcessorFactory => {
  return (ctx) => ({
    onMessage(payload) {
      seen.push({ threadId: ctx.threadId, payload });
    },
  });
};

const connect = (
  factory: StreamProcessorFactory,
  sendPrompt: (text: string) => void = () => {},
): ChannelConnection =>
  createChannelConnection({ processors: new Map([["test", factory]]), sendPrompt });

const hello = (connection: ChannelConnection, format = "test") =>
  connection.handleMessage(JSON.stringify({ type: "hello", format }));

describe("createChannelConnection", () => {
  it("accepts a hello naming a registered format", async () => {
    const connection = connect(recordingFactory([]));
    expect(await hello(connection)).toEqual({ ok: true });
  });

  it("fatally rejects a first message that is not a well-formed hello", async () => {
    for (const raw of [
      "not json",
      JSON.stringify({ type: "hi", format: "test" }),
      JSON.stringify({ type: "hello" }),
      JSON.stringify({ threadId: "t1", payload: {} }),
      JSON.stringify("hello"),
    ]) {
      const connection = connect(recordingFactory([]));
      const response = await connection.handleMessage(raw);
      expect(response.ok).toBe(false);
      expect(response.fatal).toBe(true);
    }
  });

  it("fatally rejects a hello naming an unknown format", async () => {
    const connection = connect(recordingFactory([]));
    const response = await hello(connection, "nope");
    expect(response).toMatchObject({ ok: false, fatal: true });
    expect(response.error).toContain('unknown format "nope"');
    expect(response.error).toContain("test");
  });

  it("routes each thread's payloads to its own processor, in order", async () => {
    const seen: Array<{ threadId: string; payload: unknown }> = [];
    const connection = connect(recordingFactory(seen));
    await hello(connection);

    const send = (threadId: string, payload: unknown) =>
      connection.handleMessage(JSON.stringify({ threadId, payload }));
    expect(await send("a", 1)).toEqual({ ok: true, threadId: "a" });
    expect(await send("b", 2)).toEqual({ ok: true, threadId: "b" });
    expect(await send("a", 3)).toEqual({ ok: true, threadId: "a" });

    expect(seen).toEqual([
      { threadId: "a", payload: 1 },
      { threadId: "b", payload: 2 },
      { threadId: "a", payload: 3 },
    ]);
  });

  it("creates one processor per thread id", async () => {
    let built = 0;
    const connection = connect(() => {
      built += 1;
      return { onMessage() {} };
    });
    await hello(connection);
    for (const threadId of ["a", "a", "b", "a"]) {
      await connection.handleMessage(JSON.stringify({ threadId }));
    }
    expect(built).toBe(2);
  });

  it("rejects thread messages without a usable threadId, keeping the connection alive", async () => {
    const seen: Array<{ threadId: string; payload: unknown }> = [];
    const connection = connect(recordingFactory(seen));
    await hello(connection);

    for (const raw of [
      JSON.stringify({ payload: {} }),
      JSON.stringify({ threadId: 7 }),
      JSON.stringify({ threadId: "" }),
      JSON.stringify(null),
      "not json",
    ]) {
      const response = await connection.handleMessage(raw);
      expect(response.ok).toBe(false);
      expect(response.fatal).toBeFalsy();
    }
    // Still usable afterwards.
    expect(await connection.handleMessage(JSON.stringify({ threadId: "a" }))).toEqual({
      ok: true,
      threadId: "a",
    });
  });

  it("reports the close a processor performs, then rejects further messages for that thread", async () => {
    const connection = connect((ctx) => ({
      onMessage(payload) {
        if ((payload as { done?: boolean }).done) {
          ctx.close();
        }
      },
    }));
    await hello(connection);

    const send = (threadId: string, payload: unknown) =>
      connection.handleMessage(JSON.stringify({ threadId, payload }));
    expect(await send("a", {})).toEqual({ ok: true, threadId: "a" });
    expect(await send("a", { done: true })).toEqual({ ok: true, threadId: "a", closed: true });

    const rejected = await send("a", {});
    expect(rejected).toMatchObject({ ok: false, threadId: "a" });
    expect(rejected.error).toContain('thread "a" is closed');

    // Other threads are unaffected.
    expect(await send("b", {})).toEqual({ ok: true, threadId: "b" });
  });

  it("turns a processor throw into an error reply without closing the thread", async () => {
    let calls = 0;
    const connection = connect(() => ({
      onMessage() {
        calls += 1;
        if (calls === 1) {
          throw new Error("boom");
        }
      },
    }));
    await hello(connection);

    const first = await connection.handleMessage(JSON.stringify({ threadId: "a" }));
    expect(first).toEqual({ ok: false, threadId: "a", error: "boom" });
    const second = await connection.handleMessage(JSON.stringify({ threadId: "a" }));
    expect(second).toEqual({ ok: true, threadId: "a" });
  });

  it("serializes async processors: message N+1 waits for message N to finish", async () => {
    const events: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const connection = connect(() => ({
      async onMessage(payload) {
        events.push(`start:${payload}`);
        if (payload === 1) {
          await gate;
        }
        events.push(`end:${payload}`);
      },
    }));
    await hello(connection);

    // Fire both without awaiting, as a socket would on back-to-back frames.
    const first = connection.handleMessage(JSON.stringify({ threadId: "a", payload: 1 }));
    const second = connection.handleMessage(JSON.stringify({ threadId: "a", payload: 2 }));
    await new Promise((resolve) => setImmediate(resolve));
    expect(events).toEqual(["start:1"]);

    release();
    await Promise.all([first, second]);
    expect(events).toEqual(["start:1", "end:1", "start:2", "end:2"]);
  });
});
