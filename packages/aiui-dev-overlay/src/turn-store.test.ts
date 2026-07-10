/**
 * turn-store.test.ts — the reload-survivable turn mirror: record/recover
 * round-trips, the freshness bound, and the DELIBERATE absence of a same-URL
 * gate (a turn may end its life on a different URL than it started — the
 * recovered turn reports where it was last recorded so the adopter can emit
 * the `navigation` boundary; see the SPA-navigation proposal, gotcha #5).
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IntentEvent } from "./intent-pipeline";
import { TURN_STORAGE_KEY, TurnStore } from "./turn-store";

const EVENTS: IntentEvent[] = [
  { at: 1, type: "thread-open", trigger: "ink" },
  { at: 2, type: "stroke", points: 5, bounds: { x: 0, y: 0, w: 10, h: 10 } },
];

afterEach(() => {
  sessionStorage.clear();
  vi.restoreAllMocks();
});

describe("TurnStore", () => {
  it("round-trips a live turn (soft remount) with its URL", () => {
    const store = new TurnStore();
    store.record(EVENTS, true);
    const recovered = store.recover();
    expect(recovered).toMatchObject({ source: "live", threadOpen: true, url: location.href });
    expect(recovered?.events).toHaveLength(2);
  });

  it("recovers from the sessionStorage mirror after a 'reload' (fresh instance)", () => {
    new TurnStore().record(EVENTS, true);
    const fresh = new TurnStore(); // the reloaded page's store — no live copy
    const recovered = fresh.recover();
    expect(recovered).toMatchObject({ source: "reloaded", threadOpen: true });
  });

  it("recovers ACROSS a URL change, reporting where the turn was recorded", () => {
    history.replaceState(null, "", "/page-a");
    new TurnStore().record(EVENTS, true);
    history.replaceState(null, "", "/page-b"); // the hard navigation's landing
    const recovered = new TurnStore().recover();
    expect(recovered).toBeDefined();
    expect(new URL(recovered?.url ?? "").pathname).toBe("/page-a");
    history.replaceState(null, "", "/");
  });

  it("ignores a stale mirror (freshness bound)", () => {
    new TurnStore().record(EVENTS, true);
    const then = Date.now() + 6 * 60_000; // past FRESH_MS
    vi.spyOn(Date, "now").mockReturnValue(then);
    expect(new TurnStore().recover()).toBeUndefined();
  });

  it("clear() forgets both the live copy and the mirror", () => {
    const store = new TurnStore();
    store.record(EVENTS, true);
    store.clear();
    expect(store.recover()).toBeUndefined();
    expect(sessionStorage.getItem(TURN_STORAGE_KEY)).toBeNull();
  });

  it("a closed-thread record is not recoverable", () => {
    const store = new TurnStore();
    store.record(EVENTS, false);
    expect(store.recover()).toBeUndefined();
  });
});
