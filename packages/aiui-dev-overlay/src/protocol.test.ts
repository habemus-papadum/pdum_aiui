import {
  decodeFrame,
  jsonCodec,
  PROTOCOL_VERSION as SERVER_PROTOCOL_VERSION,
} from "@habemus-papadum/aiui-claude-channel";
import { describe, expect, it } from "vitest";
import { connectIntentSocket, encodeFrame, encodeJsonPayload, PROTOCOL_VERSION } from "./protocol";
import { fakeSocketFactory } from "./test-support/fake-socket";

describe("frame encoding (cross-checked against the channel package)", () => {
  it("targets the same protocol version", () => {
    expect(PROTOCOL_VERSION).toBe(SERVER_PROTOCOL_VERSION);
  });

  it("produces frames the server-side decoder accepts", () => {
    const frame = encodeFrame(
      { v: PROTOCOL_VERSION, kind: "data", threadId: "t-9", fin: true },
      encodeJsonPayload({ text: "hello" }),
    );
    const { envelope, payload } = decodeFrame(frame);
    expect(envelope).toEqual({ v: 1, kind: "data", threadId: "t-9", fin: true });
    expect(jsonCodec.decode(payload)).toEqual({ text: "hello" });
  });

  it("encodes a payload-less frame as header only", () => {
    const frame = encodeFrame({ v: PROTOCOL_VERSION, kind: "hello", format: "text-concat" });
    const { envelope, payload } = decodeFrame(frame);
    expect(envelope.format).toBe("text-concat");
    expect(payload.length).toBe(0);
  });
});

describe("connectIntentSocket", () => {
  it("completes the hello then sends acked data frames", async () => {
    const { factory, sent } = fakeSocketFactory(() => ({ ok: true }));
    const socket = await connectIntentSocket("ws://fake/ws", "text-concat", factory);

    const ack = await socket.send("t-1", { text: "hi" }, true);
    expect(ack.ok).toBe(true);
    expect(sent).toHaveLength(2);

    const hello = decodeFrame(sent[0]);
    expect(hello.envelope).toMatchObject({ kind: "hello", format: "text-concat" });
    expect(hello.envelope).not.toHaveProperty("meta");
    const data = decodeFrame(sent[1]);
    expect(data.envelope).toMatchObject({ kind: "data", threadId: "t-1", fin: true });
    expect(jsonCodec.decode(data.payload)).toEqual({ text: "hi" });
  });

  it("carries the client meta on the hello envelope", async () => {
    const { factory, sent } = fakeSocketFactory(() => ({ ok: true }));
    const meta = {
      tab: { url: "http://localhost:5199/", title: "spectra", chromeTabId: 7 },
      source: { root: "/repo/app" },
    };
    await connectIntentSocket("ws://fake/ws", "text-concat", factory, meta);
    const hello = decodeFrame(sent[0]);
    expect(hello.envelope).toMatchObject({ kind: "hello", format: "text-concat", meta });
  });

  it("rejects when the server refuses the format", async () => {
    const { factory } = fakeSocketFactory(() => ({ ok: false, error: "unknown format" }));
    await expect(connectIntentSocket("ws://fake/ws", "nope", factory)).rejects.toThrow(
      "unknown format",
    );
  });
});
