import { describe, expect, it } from "vitest";
import { decodeFrame, type Envelope, encodeFrame, PROTOCOL_VERSION } from "./frame";

const envelope = (over: Partial<Envelope> = {}): Envelope => ({
  v: PROTOCOL_VERSION,
  kind: "data",
  threadId: "t1",
  ...over,
});

describe("encodeFrame / decodeFrame", () => {
  it("round-trips an envelope and payload", () => {
    const payload = new TextEncoder().encode("hello");
    const { envelope: env, payload: out } = decodeFrame(encodeFrame(envelope(), payload));
    expect(env).toEqual(envelope());
    expect(new TextDecoder().decode(out)).toBe("hello");
  });

  it("handles an empty payload", () => {
    const { envelope: env, payload } = decodeFrame(encodeFrame(envelope({ fin: true })));
    expect(env.fin).toBe(true);
    expect(payload.length).toBe(0);
  });

  it("round-trips an intent-v1 chunk descriptor with a binary payload", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const env = envelope({ chunk: { kind: "attachment", id: "shot_1", mime: "image/png" } });
    const { envelope: out, payload } = decodeFrame(encodeFrame(env, png));
    expect(out.chunk).toEqual({ kind: "attachment", id: "shot_1", mime: "image/png" });
    expect([...payload]).toEqual([...png]);
  });

  it("round-trips events / context chunk kinds", () => {
    for (const chunk of [{ kind: "events" }, { kind: "context" }] as const) {
      const { envelope: out } = decodeFrame(encodeFrame(envelope({ chunk })));
      expect(out.chunk).toEqual(chunk);
    }
  });

  it("round-trips a large binary payload (screenshot-sized)", () => {
    const payload = new Uint8Array(2 * 1024 * 1024);
    for (let i = 0; i < payload.length; i += 4093) {
      payload[i] = i & 0xff;
    }
    const { payload: out } = decodeFrame(encodeFrame(envelope(), payload));
    expect(out.length).toBe(payload.length);
    expect(out[4093]).toBe(4093 & 0xff);
  });

  it("decodes a frame embedded at a byte offset (as ws hands them over)", () => {
    const frame = encodeFrame(envelope(), new TextEncoder().encode("data"));
    // Nest the frame inside a larger buffer, then view it via a subarray so it
    // carries a non-zero byteOffset — the shape a pooled ws Buffer arrives in.
    const backing = new Uint8Array(frame.length + 7);
    backing.set(frame, 3);
    const view = backing.subarray(3, 3 + frame.length);
    const { envelope: env, payload } = decodeFrame(view);
    expect(env).toEqual(envelope());
    expect(new TextDecoder().decode(payload)).toBe("data");
  });

  it("returns the payload as a view, not a copy", () => {
    const frame = encodeFrame(envelope(), new Uint8Array([1, 2, 3]));
    const { payload } = decodeFrame(frame);
    expect(payload.buffer).toBe(frame.buffer);
  });

  it("throws on a frame shorter than the length prefix", () => {
    expect(() => decodeFrame(new Uint8Array([0, 0]))).toThrow(/header length prefix/);
  });

  it("throws when the header length runs past the frame", () => {
    // Claims a 16-byte header but supplies only 4 bytes after the prefix.
    const bad = new Uint8Array([0, 0, 0, 16, 1, 2, 3, 4]);
    expect(() => decodeFrame(bad)).toThrow(/exceeds frame/);
  });

  it("throws on a non-JSON header", () => {
    const bad = new Uint8Array(4 + 3);
    new DataView(bad.buffer).setUint32(0, 3, false);
    bad.set(new TextEncoder().encode("{["), 4);
    expect(() => decodeFrame(bad)).toThrow(/not valid UTF-8 JSON/);
  });
});
