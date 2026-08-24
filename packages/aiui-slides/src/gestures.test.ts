/**
 * gestures.test.ts — the intent machines against realistic input traces:
 * every rule in gestures.ts (threshold, quiet gap, direction flip, re-flick
 * spike, one-per-touch) pinned here, because the deck's whole feel hangs on
 * these being right and they are unreachable from jsdom's synthetic clocks.
 */
import { describe, expect, it } from "vitest";
import { createTouchIntent, createWheelIntent } from "./gestures";

describe("createWheelIntent", () => {
  it("one chunky mouse notch is one immediate step", () => {
    const w = createWheelIntent();
    expect(w.feed(0, 120)).toBe(1);
  });

  it("a trackpad flick with an inertia tail is exactly one step", () => {
    const w = createWheelIntent();
    // Ramp up, then the browser's decaying tail — one flick, many events.
    const deltas = [12, 30, 55, 70, 60, 48, 36, 26, 18, 12, 8, 5, 3, 2, 1];
    let steps = 0;
    deltas.forEach((d, i) => {
      steps += Math.abs(w.feed(i * 30, d));
    });
    expect(steps).toBe(1);
  });

  it("a quiet gap starts a new gesture", () => {
    const w = createWheelIntent();
    expect(w.feed(0, 120)).toBe(1);
    expect(w.feed(40, 30)).toBe(0); // tail, swallowed
    expect(w.feed(600, 90)).toBe(1); // > quietMs later: a fresh gesture
  });

  it("a re-flick spike mid-tail steps again without waiting out the tail", () => {
    const w = createWheelIntent();
    expect(w.feed(0, 80)).toBe(1);
    // The tail decays…
    expect(w.feed(30, 20)).toBe(0);
    expect(w.feed(60, 10)).toBe(0);
    expect(w.feed(90, 6)).toBe(0);
    // …and a fresh flick spikes far above it: new gesture, second step.
    expect(w.feed(120, 90)).toBe(1);
  });

  it("late-tail jitter below boostMin never re-triggers", () => {
    const w = createWheelIntent();
    expect(w.feed(0, 120)).toBe(1);
    expect(w.feed(30, 3)).toBe(0);
    expect(w.feed(60, 2)).toBe(0);
    expect(w.feed(90, 8)).toBe(0); // 8 > 2×2 but below boostMin — still tail
  });

  it("a slow deliberate drag accumulates to one step, then holds", () => {
    const w = createWheelIntent();
    const out: number[] = [];
    for (let i = 0; i < 8; i++) out.push(w.feed(i * 40, 10));
    expect(out.filter((s) => s !== 0)).toEqual([1]);
  });

  it("a direction flip is a new gesture immediately", () => {
    const w = createWheelIntent();
    expect(w.feed(0, 50)).toBe(0);
    expect(w.feed(30, 30)).toBe(1); // 80 accumulated, forward
    expect(w.feed(60, -70)).toBe(-1); // reversal: fresh accumulator, backward
  });

  it("sub-threshold gestures separated by gaps do not leak into each other", () => {
    const w = createWheelIntent();
    expect(w.feed(0, 30)).toBe(0);
    expect(w.feed(400, 40)).toBe(0); // new gesture — the 30 is forgotten
    expect(w.feed(430, 30)).toBe(1); // 40 + 30 crosses within this gesture
  });
});

describe("createTouchIntent", () => {
  it("one touch is at most one step, in the finger's direction", () => {
    const t = createTouchIntent();
    t.start(500);
    expect(t.move(470)).toBe(0); // 30 px: not yet
    expect(t.move(440)).toBe(1); // 60 px up: forward
    expect(t.move(300)).toBe(0); // keep dragging: still the same gesture
    t.end();
    t.start(500);
    expect(t.move(560)).toBe(-1); // downward drag: back
  });

  it("moves without a start are inert; end resets cleanly", () => {
    const t = createTouchIntent();
    expect(t.move(100)).toBe(0);
    t.start(200);
    t.end();
    expect(t.move(100)).toBe(0);
  });
});
