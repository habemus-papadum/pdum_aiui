/**
 * driver-watch.test.ts — the page's self-cleanup verdicts: silence → onGone
 * (hard), a new session id → onChanged (soft), and quiet idleness in between.
 * The CDP page-script carries an inline twin of this logic; this file is the
 * tested reference implementation (content.ts imports it directly).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDriverWatch } from "./driver-watch";

describe("createDriverWatch", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function watch() {
    const gone: number[] = [];
    const changed: number[] = [];
    const w = createDriverWatch({
      timeoutMs: 7000,
      onGone: () => gone.push(Date.now()),
      onChanged: () => changed.push(Date.now()),
    });
    return { w, gone, changed };
  }

  it("beats keep it quiet; silence past the timeout fires onGone once", () => {
    const { w, gone, changed } = watch();
    w.alive("driver-a");
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(2000);
      w.alive("driver-a"); // a live driver keeps beating
    }
    expect(gone).toHaveLength(0);

    // The driver dies: no more beats. One verdict, then the timer stands down.
    vi.advanceTimersByTime(10000);
    expect(gone).toHaveLength(1);
    vi.advanceTimersByTime(30000);
    expect(gone).toHaveLength(1);
    expect(changed).toHaveLength(0);
  });

  it("a NEW session id on a beat fires onChanged (soft), not onGone", () => {
    const { w, gone, changed } = watch();
    w.alive("driver-a");
    vi.advanceTimersByTime(2000);
    w.alive("driver-b"); // the panel was reloaded — same page, new driver
    expect(changed).toHaveLength(1);
    expect(gone).toHaveLength(0);
    // The new driver's beats keep the page alive as usual.
    vi.advanceTimersByTime(2000);
    w.alive("driver-b");
    expect(changed).toHaveLength(1);
  });

  it("plain proof-of-life (no session) never triggers a change verdict", () => {
    const { w, gone, changed } = watch();
    w.alive("driver-a");
    w.alive(); // an assertion request — proves life, names nobody
    expect(changed).toHaveLength(0);
    vi.advanceTimersByTime(10000);
    expect(gone).toHaveLength(1);
  });

  it("re-arms after a verdict: a returning driver gets watched again", () => {
    const { w, gone } = watch();
    w.alive("driver-a");
    vi.advanceTimersByTime(10000);
    expect(gone).toHaveLength(1);

    w.alive("driver-b"); // a fresh panel found the page — no stale "changed"
    vi.advanceTimersByTime(10000);
    expect(gone).toHaveLength(2);
  });

  it("dispose stops the clock", () => {
    const { w, gone } = watch();
    w.alive("driver-a");
    w.dispose();
    vi.advanceTimersByTime(30000);
    expect(gone).toHaveLength(0);
  });
});
