import { describe, expect, it } from "vitest";
import { type ChannelConnection, type ChannelFormat, createChannelConnection } from "./channel";
import { jsonCodec, type PayloadCodec } from "./codec";
import { encodeFrame, PROTOCOL_VERSION } from "./frame";

const helloFrame = (format = "test"): Uint8Array =>
  encodeFrame({ v: PROTOCOL_VERSION, kind: "hello", format });

const dataFrame = (threadId: string, payload?: unknown, fin = false): Uint8Array =>
  encodeFrame(
    { v: PROTOCOL_VERSION, kind: "data", threadId, fin },
    payload === undefined ? undefined : jsonCodec.encode(payload),
  );

/** A format that records every (threadId, payload, fin) its processor sees. */
const recordingFormat = (
  seen: Array<{ threadId: string; payload: unknown; fin: boolean }>,
  codec: PayloadCodec = jsonCodec,
): ChannelFormat => ({
  codec,
  createProcessor: (ctx) => ({
    onMessage(payload, meta) {
      seen.push({ threadId: ctx.threadId, payload, fin: meta.fin });
    },
  }),
});

const connect = (
  format: ChannelFormat,
  sendPrompt: (text: string) => void = () => {},
): ChannelConnection =>
  createChannelConnection({ formats: new Map([["test", format]]), sendPrompt });

describe("createChannelConnection", () => {
  it("accepts a hello naming a registered format", async () => {
    const connection = connect(recordingFormat([]));
    expect(await connection.handleFrame(helloFrame())).toEqual({ ok: true });
  });

  it("hands the hello's client meta to every thread's processor", async () => {
    const seen: unknown[] = [];
    const format: ChannelFormat = {
      codec: jsonCodec,
      createProcessor: (ctx) => {
        seen.push(ctx.hello);
        return { onMessage() {} };
      },
    };
    const connection = connect(format);
    const meta = {
      tab: { url: "http://localhost:5199/", title: "spectra", chromeTabId: 7 },
      source: { root: "/repo/app" },
    };
    await connection.handleFrame(
      encodeFrame({ v: PROTOCOL_VERSION, kind: "hello", format: "test", meta }),
    );
    await connection.handleFrame(dataFrame("t1", {}));
    await connection.handleFrame(dataFrame("t2", {}));
    expect(seen).toEqual([meta, meta]);
  });

  it("fatally rejects a first frame that is not a well-formed hello", async () => {
    const frames = [
      new Uint8Array([0, 0]), // truncated: no header length
      new Uint8Array([0, 0, 0, 16, 1, 2]), // header length overruns the frame
      encodeFrame({ v: PROTOCOL_VERSION, kind: "data", threadId: "t1" }), // data before hello
      encodeFrame({ v: PROTOCOL_VERSION, kind: "hello" }), // hello with no format
    ];
    for (const frame of frames) {
      const connection = connect(recordingFormat([]));
      const response = await connection.handleFrame(frame);
      expect(response.ok).toBe(false);
      expect(response.fatal).toBe(true);
    }
  });

  it("fatally rejects a hello naming an unknown format", async () => {
    const connection = connect(recordingFormat([]));
    const response = await connection.handleFrame(helloFrame("nope"));
    expect(response).toMatchObject({ ok: false, fatal: true });
    expect(response.error).toContain('unknown format "nope"');
    expect(response.error).toContain("test");
  });

  it("routes each thread's payloads to its own processor, in order, with fin", async () => {
    const seen: Array<{ threadId: string; payload: unknown; fin: boolean }> = [];
    const connection = connect(recordingFormat(seen));
    await connection.handleFrame(helloFrame());

    expect(await connection.handleFrame(dataFrame("a", { n: 1 }))).toEqual({
      ok: true,
      threadId: "a",
    });
    expect(await connection.handleFrame(dataFrame("b", { n: 2 }))).toEqual({
      ok: true,
      threadId: "b",
    });
    await connection.handleFrame(dataFrame("a", { n: 3 }, true));

    expect(seen).toEqual([
      { threadId: "a", payload: { n: 1 }, fin: false },
      { threadId: "b", payload: { n: 2 }, fin: false },
      { threadId: "a", payload: { n: 3 }, fin: true },
    ]);
  });

  it("creates one processor per thread id", async () => {
    let built = 0;
    const connection = connect({
      codec: jsonCodec,
      createProcessor: () => {
        built += 1;
        return { onMessage() {} };
      },
    });
    await connection.handleFrame(helloFrame());
    for (const threadId of ["a", "a", "b", "a"]) {
      await connection.handleFrame(dataFrame(threadId, {}));
    }
    expect(built).toBe(2);
  });

  it("rejects data frames without a usable threadId, keeping the connection alive", async () => {
    const connection = connect(recordingFormat([]));
    await connection.handleFrame(helloFrame());

    const bad = [
      encodeFrame({ v: PROTOCOL_VERSION, kind: "data" }), // no threadId
      encodeFrame({ v: PROTOCOL_VERSION, kind: "data", threadId: "" }), // empty threadId
      encodeFrame({ v: PROTOCOL_VERSION, kind: "hello", format: "test" }), // wrong kind now
    ];
    for (const frame of bad) {
      const response = await connection.handleFrame(frame);
      expect(response.ok).toBe(false);
      expect(response.fatal).toBeFalsy();
    }
    expect(await connection.handleFrame(dataFrame("a", {}))).toEqual({ ok: true, threadId: "a" });
  });

  it("reports a payload decode failure without closing the thread", async () => {
    const throwingCodec: PayloadCodec = {
      id: "throwing",
      encode: () => new Uint8Array(0),
      decode: () => {
        throw new Error("bad bytes");
      },
    };
    const connection = connect(recordingFormat([], throwingCodec));
    await connection.handleFrame(helloFrame());

    const response = await connection.handleFrame(
      encodeFrame({ v: PROTOCOL_VERSION, kind: "data", threadId: "a" }, new Uint8Array([9])),
    );
    expect(response).toMatchObject({ ok: false, threadId: "a" });
    expect(response.error).toContain("payload decode failed");
  });

  it("reports the close a processor performs, then rejects further frames for that thread", async () => {
    const connection = connect({
      codec: jsonCodec,
      createProcessor: (ctx) => ({
        onMessage(_payload, meta) {
          if (meta.fin) {
            ctx.close();
          }
        },
      }),
    });
    await connection.handleFrame(helloFrame());

    expect(await connection.handleFrame(dataFrame("a", {}))).toEqual({ ok: true, threadId: "a" });
    expect(await connection.handleFrame(dataFrame("a", {}, true))).toEqual({
      ok: true,
      threadId: "a",
      closed: true,
    });

    const rejected = await connection.handleFrame(dataFrame("a", {}));
    expect(rejected).toMatchObject({ ok: false, threadId: "a" });
    expect(rejected.error).toContain('thread "a" is closed');

    expect(await connection.handleFrame(dataFrame("b", {}))).toEqual({ ok: true, threadId: "b" });
  });

  it("turns a processor throw into an error reply without closing the thread", async () => {
    let calls = 0;
    const connection = connect({
      codec: jsonCodec,
      createProcessor: () => ({
        onMessage() {
          calls += 1;
          if (calls === 1) {
            throw new Error("boom");
          }
        },
      }),
    });
    await connection.handleFrame(helloFrame());

    expect(await connection.handleFrame(dataFrame("a", {}))).toEqual({
      ok: false,
      threadId: "a",
      error: "boom",
    });
    expect(await connection.handleFrame(dataFrame("a", {}))).toEqual({ ok: true, threadId: "a" });
  });

  it("serializes async processors: frame N+1 waits for frame N to finish", async () => {
    const events: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const connection = connect({
      codec: jsonCodec,
      createProcessor: () => ({
        async onMessage(payload) {
          const n = (payload as { n: number }).n;
          events.push(`start:${n}`);
          if (n === 1) {
            await gate;
          }
          events.push(`end:${n}`);
        },
      }),
    });
    await connection.handleFrame(helloFrame());

    const first = connection.handleFrame(dataFrame("a", { n: 1 }));
    const second = connection.handleFrame(dataFrame("a", { n: 2 }));
    await new Promise((resolve) => setImmediate(resolve));
    expect(events).toEqual(["start:1"]);

    release();
    await Promise.all([first, second]);
    expect(events).toEqual(["start:1", "end:1", "start:2", "end:2"]);
  });
});
