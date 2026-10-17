// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { guardedEffect } from "./effect";

describe("guardedEffect", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a clean completion is ok, value attached", async () => {
    const outcome = await guardedEffect({}, async () => "shot.png");
    expect(outcome).toEqual({ status: "ok", value: "shot.png" });
  });

  it("revalidates at COMPLETION time: a world that moved on makes the result stale", async () => {
    let valid = true; // launch-time check would have passed…
    let land!: (value: string) => void;
    const outcome = guardedEffect(
      { stillValid: () => valid },
      () =>
        new Promise<string>((resolve) => {
          land = resolve;
        }),
    );
    valid = false; // …but the turn was sent while the share picker was up
    land("late-shot.png");
    // The value still comes back (for tracing), flagged so the caller drops it.
    expect(await outcome).toEqual({ status: "stale", value: "late-shot.png" });
  });

  it("stillValid that holds at completion keeps the ok outcome", async () => {
    const outcome = await guardedEffect({ stillValid: () => true }, async () => 7);
    expect(outcome).toEqual({ status: "ok", value: 7 });
  });

  it("the ceiling fires on a wedged effect: timeout outcome, signal aborted", async () => {
    let seen: AbortSignal | undefined;
    const outcome = guardedEffect({ ceilingMs: 100 }, (signal) => {
      seen = signal;
      return new Promise<never>(() => {}); // a transcript that will never come
    });
    expect(seen?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    expect(await outcome).toEqual({ status: "timeout" });
    expect(seen?.aborted).toBe(true);
  });

  it("the abort WE caused reads as timeout, not error", async () => {
    const outcome = guardedEffect(
      { ceilingMs: 50 },
      (signal) =>
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted by ceiling")));
        }),
    );
    await vi.advanceTimersByTimeAsync(50);
    expect(await outcome).toEqual({ status: "timeout" });
  });

  it("never rejects: a throwing effect comes back as error data", async () => {
    const denied = new Error("mic permission denied");
    const outcome = await guardedEffect({}, async () => {
      throw denied;
    });
    expect(outcome).toEqual({ status: "error", error: denied });
  });

  it("clears the ceiling timer on early completion — no dangling timer after the effect lands", async () => {
    const outcome = await guardedEffect({ ceilingMs: 60_000 }, async () => "quick");
    expect(outcome).toEqual({ status: "ok", value: "quick" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the timer on the error path too", async () => {
    const outcome = await guardedEffect({ ceilingMs: 60_000 }, async () => {
      throw new Error("early failure");
    });
    expect(outcome.status).toBe("error");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("an outer signal's abort is forwarded at once and reads as `aborted`, not error", async () => {
    const outer = new AbortController();
    let seen: AbortSignal | undefined;
    const outcome = guardedEffect({ signal: outer.signal, ceilingMs: 60_000 }, (signal) => {
      seen = signal;
      return new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
    expect(seen?.aborted).toBe(false);
    outer.abort(new Error("superseded"));
    expect(seen?.aborted).toBe(true); // forwarded synchronously, long before the ceiling
    expect(seen?.reason).toEqual(new Error("superseded"));
    expect(await outcome).toEqual({ status: "aborted" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("an already-aborted outer signal aborts the run's signal before it starts", async () => {
    const outer = new AbortController();
    outer.abort();
    const outcome = await guardedEffect({ signal: outer.signal }, async (signal) => {
      if (signal.aborted) {
        throw new Error("never started");
      }
      return "ran";
    });
    expect(outcome).toEqual({ status: "aborted" });
  });

  it("a run that lands despite the outer abort is judged by stillValid, like any late result", async () => {
    const outer = new AbortController();
    let land!: (value: string) => void;
    const outcome = guardedEffect(
      { signal: outer.signal, stillValid: () => !outer.signal.aborted },
      () =>
        new Promise<string>((resolve) => {
          land = resolve;
        }),
    );
    outer.abort();
    land("stream"); // getUserMedia cannot be cancelled: the stream arrives anyway
    expect(await outcome).toEqual({ status: "stale", value: "stream" }); // handed back to release
  });
});
