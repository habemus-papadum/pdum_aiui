import { describe, expect, it } from "vitest";
import {
  decode,
  encode,
  fromNorm,
  isInkIntent,
  type Signal,
  toNorm,
  type WirePoint,
} from "./protocol";
import type { PenSample } from "./telemetry";

const sample = (over: Partial<PenSample> = {}): PenSample => ({
  x: 100,
  y: 50,
  t: 1000,
  pressure: 0.6,
  altitude: Math.PI / 3,
  azimuth: 0.4,
  twist: 0,
  kind: "pen",
  width: 0,
  height: 0,
  ...over,
});

describe("coordinates — the point of normalizing them", () => {
  it("round-trips through surfaces that disagree about pixels", () => {
    // The iPad's canvas and the host's are different sizes; that is the case the
    // wire exists for. A point at the middle of one is the middle of the other.
    const ipad = { width: 820, height: 1180 };
    const host = { width: 1512, height: 982 };

    const wire = toNorm(sample({ x: 410, y: 590 }), ipad);
    const onHost = fromNorm(wire, host);

    expect(wire.u).toBeCloseTo(0.5);
    expect(wire.v).toBeCloseTo(0.5);
    expect(onHost.x).toBeCloseTo(756);
    expect(onHost.y).toBeCloseTo(491);
  });

  it("carries the WHOLE instrument, not just position", () => {
    // Dropping tilt on the wire would silently reduce the remote pencil to a pen
    // with no charcoal in it — the failure would look like a tuning problem.
    const wire = toNorm(sample(), { width: 1000, height: 1000 });
    expect(wire.p).toBeCloseTo(0.6);
    expect(wire.alt).toBeCloseTo(Math.PI / 3);
    expect(wire.az).toBeCloseTo(0.4);
    expect(wire.t).toBe(1000);

    const back = fromNorm(wire, { width: 1000, height: 1000 });
    expect(back.pressure).toBeCloseTo(0.6);
    expect(back.altitude).toBeCloseTo(Math.PI / 3);
    expect(back.azimuth).toBeCloseTo(0.4);
  });

  it("treats an absent altitude as an upright pen — the mouse degrades by geometry", () => {
    const bare: WirePoint = { u: 0.5, v: 0.5, t: 0 };
    const mouse = fromNorm(bare, { width: 100, height: 100 }, "mouse");
    expect(mouse.altitude).toBe(Math.PI / 2); // upright: a round dab, no ellipse
    expect(mouse.azimuth).toBe(0);
    expect(mouse.pressure).toBe(0); // …and no pressure, so velocity drives the width
  });

  it("does not poison downstream numbers when the surface has not been laid out", () => {
    const wire = toNorm(sample(), { width: 0, height: 0 });
    expect(wire.u).toBe(0);
    expect(wire.v).toBe(0);
    expect(Number.isNaN(wire.u)).toBe(false);
  });
});

describe("framing", () => {
  it("round-trips a message", () => {
    const signal: Signal = { type: "signal", peer: "client-7", data: { sdp: "offer…" } };
    expect(decode(encode(signal))).toEqual(signal);
  });

  it("drops a malformed frame instead of throwing — one bad client must not sink the relay", () => {
    expect(decode("not json")).toBeUndefined();
    expect(decode("[1,2,3]")).toBeUndefined(); // JSON, but not a message
    expect(decode('{"no":"type"}')).toBeUndefined();
    expect(decode("null")).toBeUndefined();
  });

  it("recognises ink intent — the relay's routing test", () => {
    expect(isInkIntent({ type: "strokePoints", id: "x", points: [] })).toBe(true);
    expect(isInkIntent({ type: "undo" })).toBe(true);
    // Navigation gestures are ink intents too (D5): continuous, plane-relative.
    expect(isInkIntent({ type: "scroll", du: 0, dv: 0.1 })).toBe(true);
    expect(isInkIntent({ type: "zoom", centerU: 0.5, centerV: 0.5, scale: 1.1 })).toBe(true);
    // …and the bar is NOT this wire's business (D5: its own channel).
    expect(isInkIntent({ type: "command", command: "ink.toggle" })).toBe(false);
    expect(isInkIntent(undefined)).toBe(false);
  });
});
