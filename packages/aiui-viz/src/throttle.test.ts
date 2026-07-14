// @vitest-environment jsdom
/**
 * throttle.test.ts — the write policy, pinned.
 *
 * The load-bearing claim is the trailing edge: the LAST value always lands. A
 * rate limiter that drops it is worse than no rate limiter, because the value
 * you lose is the one at the end of the gesture — the final telemetry of a
 * stroke, the resting position of a camera — which is exactly the one being
 * watched for.
 */
import { createRoot, flush } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { disposeDurable, durableSignal } from "./durable";
import { throttled } from "./throttle";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  disposeDurable("t:throttle");
});

/** A throttled box over a durable signal, in a reactive root, with a commit log. */
function harness(hz: number) {
  return createRoot((dispose) => {
    const box = throttled(durableSignal<number>("t:throttle", 0), hz);
    const commits: number[] = [];
    const read = () => {
      flush();
      const v = box.get();
      if (commits.at(-1) !== v) commits.push(v);
      return v;
    };
    return { box, commits, read, dispose };
  });
}

describe("throttled", () => {
  it("publishes the first write immediately — the leading edge", () => {
    const h = harness(4);
    h.box.set(1);
    expect(h.read()).toBe(1); // no timer advance: the UI reacts at once
    h.dispose();
  });

  it("coalesces a burst into ONE commit, latest wins", () => {
    const h = harness(4); // a 250 ms window
    h.box.set(1); // leading — commits now
    for (let i = 2; i <= 50; i++) h.box.set(i); // 49 more writes inside the window
    expect(h.read()).toBe(1); // …and the graph has seen exactly one

    vi.advanceTimersByTime(250);
    expect(h.read()).toBe(50); // the window closed: the LATEST, not the next
    h.dispose();
  });

  it("lands the last value even when the island then goes silent forever", () => {
    // The whole point. A 120 Hz pen stops mid-window; its final sample must not
    // sit in a buffer waiting for a write that never comes.
    const h = harness(4);
    h.box.set(1);
    h.box.set(2);
    h.box.set(3); // silence after this

    vi.advanceTimersByTime(250);
    expect(h.read()).toBe(3);

    vi.advanceTimersByTime(10_000); // nothing further, and nothing lost
    expect(h.read()).toBe(3);
    h.dispose();
  });

  it("holds a sustained island to ~hz commits per second", () => {
    const h = harness(4);
    // 1000 writes over one simulated second — a 1 kHz island, absurd on purpose.
    for (let ms = 0; ms < 1000; ms++) {
      h.box.set(ms);
      vi.advanceTimersByTime(1);
      h.read();
    }
    vi.advanceTimersByTime(250);
    h.read();

    // 4 Hz over a second: the leading commit plus one per closed window.
    expect(h.commits.length).toBeLessThanOrEqual(6);
    expect(h.commits.length).toBeGreaterThanOrEqual(4);
    expect(h.commits.at(-1)).toBe(999); // and the last value still lands
    h.dispose();
  });

  it("resolves an updater against the last OFFERED value, not the last committed one", () => {
    // Two increments inside one window must yield 2, not 1 — the island's writes
    // are not lost just because the graph has not seen them yet.
    const h = harness(4);
    h.box.set(0);
    h.box.set((n) => n + 1);
    h.box.set((n) => n + 1);

    vi.advanceTimersByTime(250);
    expect(h.read()).toBe(2);
    h.dispose();
  });

  it("flush() publishes a coalesced value right now", () => {
    const h = harness(4);
    h.box.set(1);
    h.box.set(2);
    expect(h.read()).toBe(1);

    h.box.flush();
    expect(h.read()).toBe(2); // no timer advance at all
    h.dispose();
  });

  it("keeps the underlying box's durability — the point of wrapping rather than replacing", () => {
    const h = harness(4);
    h.box.set(7);
    h.read();
    h.dispose();

    // A "hot edit": the module re-evaluates, wrapping the SAME durable signal.
    const next = createRoot((dispose) => {
      const box = throttled(durableSignal<number>("t:throttle", 0), 4);
      return { box, dispose };
    });
    flush();
    expect(next.box.get()).toBe(7); // the user's state survived; only the valve is new
    next.dispose();
  });
});
