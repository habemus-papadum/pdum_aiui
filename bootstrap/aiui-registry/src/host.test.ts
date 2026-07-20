import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  decodeNativeFrames,
  encodeNativeFrame,
  handleNativeRequest,
  runNativeHost,
} from "./host.ts";
import type { ChannelListing } from "./types.ts";
import { PROTOCOL } from "./types.ts";

const emptyListing = (): ChannelListing => ({
  protocol: PROTOCOL,
  channels: [],
  agents: { status: "ok", fetchedAt: "2026-07-20T00:00:00.000Z" },
});

describe("frame codecs", () => {
  it("round-trips a message", () => {
    const { messages, rest } = decodeNativeFrames(encodeNativeFrame({ cmd: "ping", n: 7 }));
    expect(messages).toEqual([{ cmd: "ping", n: 7 }]);
    expect(rest.length).toBe(0);
  });

  it("buffers partial frames and decodes multiple complete ones", () => {
    const a = encodeNativeFrame({ a: 1 });
    const b = encodeNativeFrame({ b: 2 });
    const joined = Buffer.concat([a, b.subarray(0, 3)]);
    const first = decodeNativeFrames(joined);
    expect(first.messages).toEqual([{ a: 1 }]);
    expect(first.rest.length).toBe(3);
    const second = decodeNativeFrames(Buffer.concat([first.rest, b.subarray(3)]));
    expect(second.messages).toEqual([{ b: 2 }]);
  });

  it("yields undefined for unparseable JSON in a complete frame", () => {
    const body = Buffer.from("not json", "utf8");
    const frame = Buffer.allocUnsafe(4 + body.length);
    frame.writeUInt32LE(body.length, 0);
    body.copy(frame, 4);
    const { messages } = decodeNativeFrames(frame);
    expect(messages).toEqual([undefined]);
  });
});

describe("handleNativeRequest", () => {
  it("answers ping with protocol and a timestamp", () => {
    const res = handleNativeRequest({ cmd: "ping" }, emptyListing);
    expect(res.ok).toBe(true);
    expect(res.protocol).toBe(PROTOCOL);
    expect(typeof res.at).toBe("string");
  });

  it("answers version with the protocol", () => {
    expect(handleNativeRequest({ cmd: "version" }, emptyListing)).toEqual({
      ok: true,
      protocol: PROTOCOL,
    });
  });

  it("answers listChannels with the listing spread in", () => {
    const res = handleNativeRequest({ cmd: "listChannels" }, emptyListing);
    expect(res).toMatchObject({ ok: true, protocol: PROTOCOL, channels: [] });
    expect((res.agents as { status: string }).status).toBe("ok");
  });

  it("rejects unknown commands and non-objects, protocol included", () => {
    expect(handleNativeRequest({ cmd: "nope" }, emptyListing)).toMatchObject({
      ok: false,
      protocol: PROTOCOL,
    });
    expect(handleNativeRequest(undefined, emptyListing)).toMatchObject({ ok: false });
  });
});

describe("runNativeHost", () => {
  it("answers every frame until stdin ends, and errors survive the loop", async () => {
    const input = new PassThrough();
    const chunks: Buffer[] = [];
    const done = runNativeHost({
      list: () => {
        throw new Error("listing exploded");
      },
      input,
      output: { write: (c: Buffer) => chunks.push(c) },
    });
    input.write(encodeNativeFrame({ cmd: "ping" }));
    input.write(encodeNativeFrame({ cmd: "listChannels" }));
    input.end();
    await done;
    const { messages } = decodeNativeFrames(Buffer.concat(chunks));
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ ok: true, protocol: PROTOCOL });
    expect(messages[1]).toMatchObject({ ok: false, error: "listing exploded" });
  });
});
