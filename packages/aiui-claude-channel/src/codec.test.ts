import { describe, expect, it } from "vitest";
import { jsonCodec, rawCodec } from "./codec";

describe("jsonCodec", () => {
  it("round-trips objects, arrays, and scalars", () => {
    for (const value of [{ text: "hi", n: 1 }, [1, 2, 3], "s", 42, true, null]) {
      expect(jsonCodec.decode(jsonCodec.encode(value))).toEqual(value);
    }
  });

  it("decodes an empty payload to undefined", () => {
    expect(jsonCodec.decode(new Uint8Array(0))).toBeUndefined();
  });

  it("encodes undefined as JSON null", () => {
    expect(jsonCodec.decode(jsonCodec.encode(undefined))).toBeNull();
  });
});

describe("rawCodec", () => {
  it("passes bytes through unchanged, without copying", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    expect(rawCodec.encode(bytes)).toBe(bytes);
    expect(rawCodec.decode(bytes)).toBe(bytes);
  });
});
