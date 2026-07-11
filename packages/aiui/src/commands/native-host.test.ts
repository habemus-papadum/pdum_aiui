import { describe, expect, it } from "vitest";
import { decodeNativeFrames, encodeNativeFrame, handleNativeRequest } from "./native-host";

describe("native-messaging framing", () => {
  it("round-trips a message", () => {
    const frame = encodeNativeFrame({ cmd: "ping" });
    const { messages, rest } = decodeNativeFrames(frame);
    expect(messages).toEqual([{ cmd: "ping" }]);
    expect(rest.length).toBe(0);
  });

  it("handles split and concatenated frames", () => {
    const two = Buffer.concat([encodeNativeFrame({ a: 1 }), encodeNativeFrame({ b: 2 })]);
    const cut = 5; // mid-first-body
    const first = decodeNativeFrames(two.subarray(0, cut));
    expect(first.messages).toEqual([]);
    const second = decodeNativeFrames(Buffer.concat([first.rest, two.subarray(cut)]));
    expect(second.messages).toEqual([{ a: 1 }, { b: 2 }]);
    expect(second.rest.length).toBe(0);
  });

  it("yields undefined for a corrupt body instead of throwing", () => {
    const good = encodeNativeFrame({ ok: 1 });
    const corrupt = Buffer.from(good);
    corrupt[4] = 0x7d; // stomp the opening brace: "}..." is not JSON
    const { messages } = decodeNativeFrames(corrupt);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toBeUndefined();
  });
});

describe("handleNativeRequest", () => {
  it("answers ping/version and rejects unknowns", () => {
    expect(handleNativeRequest({ cmd: "ping" })).toMatchObject({ ok: true });
    expect(handleNativeRequest({ cmd: "version" })).toEqual({ ok: true, version: 1 });
    expect(handleNativeRequest({ cmd: "nope" })).toMatchObject({ ok: false });
    expect(handleNativeRequest(null)).toMatchObject({ ok: false });
  });
});
