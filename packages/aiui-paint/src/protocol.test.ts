import { describe, expect, it } from "vitest";
import { type ClientToRelay, decode, encode, fromNorm, isPaintIntent, toNorm } from "./protocol";

describe("encode/decode", () => {
  it("round-trips a control message", () => {
    const msg: ClientToRelay = { type: "join", host: "h1" };
    expect(decode(encode(msg))).toEqual(msg);
  });

  it("round-trips a stroke intent with style and points", () => {
    const msg: ClientToRelay = {
      type: "strokeBegin",
      id: "s1",
      pointerType: "pen",
      style: { color: "#0af", width: 6 },
      point: { u: 0.5, v: 0.25, pressure: 0.7 },
    };
    expect(decode(encode(msg))).toEqual(msg);
  });

  it("returns undefined for non-JSON, non-objects, and missing type", () => {
    expect(decode("not json")).toBeUndefined();
    expect(decode("42")).toBeUndefined();
    expect(decode("null")).toBeUndefined();
    expect(decode(JSON.stringify({ nope: 1 }))).toBeUndefined();
  });
});

describe("isPaintIntent", () => {
  it("accepts paint/nav intents and rejects control frames", () => {
    expect(isPaintIntent({ type: "strokeBegin" })).toBe(true);
    expect(isPaintIntent({ type: "scroll" })).toBe(true);
    expect(isPaintIntent({ type: "zoom" })).toBe(true);
    expect(isPaintIntent({ type: "setArmed" })).toBe(true);
    expect(isPaintIntent({ type: "join" })).toBe(false);
    expect(isPaintIntent({ type: "viewState" })).toBe(false);
    expect(isPaintIntent({ type: "signal" })).toBe(false);
  });
});

describe("coordinate helpers", () => {
  it("normalizes and clamps to 0..1", () => {
    expect(toNorm(50, 25, 100, 100)).toEqual({ u: 0.5, v: 0.25 });
    expect(toNorm(-10, 200, 100, 100)).toEqual({ u: 0, v: 1 });
    expect(toNorm(10, 10, 0, 0)).toEqual({ u: 0, v: 0 });
  });

  it("round-trips through fromNorm", () => {
    const { u, v } = toNorm(30, 80, 200, 400);
    expect(fromNorm(u, v, 200, 400)).toEqual({ x: 30, y: 80 });
  });
});
