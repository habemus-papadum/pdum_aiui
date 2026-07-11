import { describe, expect, it } from "vitest";
import { fromRelayResult, isRelayEnvelope, toRelayResult } from "./relay";

describe("relay codecs", () => {
  it("recognizes envelopes addressed to the given context only", () => {
    expect(isRelayEnvelope({ aiui: 1, to: "sw", cmd: "x" }, "sw")).toBe(true);
    expect(isRelayEnvelope({ aiui: 1, to: "panel", cmd: "x" }, "sw")).toBe(false);
    expect(isRelayEnvelope({ to: "sw", cmd: "x" }, "sw")).toBe(false); // no guard
    expect(isRelayEnvelope({ aiui: 1, to: "sw" }, "sw")).toBe(false); // no cmd
    expect(isRelayEnvelope(null, "sw")).toBe(false);
    expect(isRelayEnvelope("string", "sw")).toBe(false);
  });

  it("round-trips values", () => {
    expect(fromRelayResult(toRelayResult({ value: { a: 1 } }))).toEqual({ a: 1 });
    expect(fromRelayResult(toRelayResult({ value: undefined }))).toBeUndefined();
  });

  it("marshals errors as rejections with the original message", () => {
    const wire = toRelayResult({ error: new Error("boom") });
    expect(() => fromRelayResult(wire)).toThrow("boom");
    expect(() => fromRelayResult(toRelayResult({ error: "plain" }))).toThrow("plain");
  });

  it("treats a missing response as a dead-context error", () => {
    // chrome.runtime.sendMessage resolves undefined when nothing answered.
    expect(() => fromRelayResult(undefined)).toThrow(/target context alive/);
  });
});
