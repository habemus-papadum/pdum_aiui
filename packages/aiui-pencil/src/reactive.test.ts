// @vitest-environment jsdom
/**
 * reactive.test.ts — the two-cadence contract, driven by a fake source.
 *
 * The load-bearing claims: the committed signal is never throttled; the live
 * signal is throttled but lossless (cumulative snapshots); and a stroke is
 * never visible in both signals at once, even mid-throttle-window.
 */
import { flush } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type InkSource, inkSignals } from "./reactive";
import type { InkEvent, InkState, InkStroke } from "./surface";
import type { PenSample } from "./telemetry";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const pt = (x: number, i: number): PenSample => ({
  x,
  y: 0,
  t: i * 8,
  pressure: 0.5,
  altitude: Math.PI / 2,
  azimuth: 0,
  twist: 0,
  kind: "pen",
  width: 0,
  height: 0,
});

/** A hand-cranked surface: the test IS the pen. */
class FakeSource implements InkSource {
  strokes: InkStroke[] = [];
  liveStrokes: InkStroke[] = [];
  private listeners = new Set<(event: InkEvent) => void>();

  ink(): InkState {
    return { strokes: [...this.strokes], live: this.liveStrokes.map((s) => ({ ...s })) };
  }
  subscribe(listener: (event: InkEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(event: InkEvent): void {
    for (const l of this.listeners) l(event);
  }

  grow(id: string, points: readonly PenSample[]): void {
    const found = this.liveStrokes.find((s) => s.id === id);
    if (found) {
      found.points = points;
    } else {
      this.liveStrokes.push({ id, tool: "draw", points, bornAt: 0 });
    }
    this.emit("live");
  }
  commit(id: string): void {
    const i = this.liveStrokes.findIndex((s) => s.id === id);
    const [stroke] = this.liveStrokes.splice(i, 1);
    this.strokes.push(stroke);
    this.emit("live"); // left the live set…
    this.emit("strokes"); // …and joined the drawing
  }
}

const read = <T>(get: () => T): T => {
  flush();
  return get();
};

describe("inkSignals", () => {
  it("starts from the source's current state — a hot swap adopts, never resets", () => {
    const source = new FakeSource();
    source.strokes.push({ id: "old", tool: "draw", points: [pt(0, 0)], bornAt: 0 });
    const ink = inkSignals(source);
    expect(read(ink.strokes).map((s) => s.id)).toEqual(["old"]);
    ink.dispose();
  });

  it("commits are immediate; the live firehose is throttled", () => {
    const source = new FakeSource();
    const ink = inkSignals(source, { liveHz: 4 }); // a 250 ms window

    source.grow("s1", [pt(0, 0)]);
    expect(read(ink.live).length).toBe(1); // leading edge: pen-down shows at once

    for (let i = 1; i <= 30; i++) {
      source.grow(
        "s1",
        Array.from({ length: i + 1 }, (_, k) => pt(k, k)),
      );
    }
    expect(read(ink.live)[0].points.length).toBe(1); // mid-window: still the leading snapshot

    vi.advanceTimersByTime(250);
    // The trailing edge carries the LATEST snapshot — all 31 points. Nothing the
    // throttle dropped is missing from it: emissions were lost, data was not.
    expect(read(ink.live)[0].points.length).toBe(31);
    ink.dispose();
  });

  it("never shows a stroke in both signals, even mid-window", () => {
    const source = new FakeSource();
    const ink = inkSignals(source, { liveHz: 4 });

    source.grow("s1", [pt(0, 0)]);
    source.grow("s1", [pt(0, 0), pt(1, 1)]); // coalescing: a window is open
    source.commit("s1"); // pen-up lands INSIDE the window

    // The commit must not wait 250 ms to leave `live` — the flush moves both
    // signals together, or a consumer summing them double-counts the stroke.
    expect(read(ink.strokes).map((s) => s.id)).toEqual(["s1"]);
    expect(read(ink.live)).toEqual([]);
    ink.dispose();
  });

  it("dispose stops following; the last values remain readable", () => {
    const source = new FakeSource();
    const ink = inkSignals(source);
    source.grow("s1", [pt(0, 0)]);
    source.commit("s1");
    expect(read(ink.strokes).length).toBe(1);

    ink.dispose();
    source.grow("s2", [pt(5, 0)]);
    source.commit("s2");
    expect(read(ink.strokes).length).toBe(1); // still yesterday's paper, by design
  });
});
