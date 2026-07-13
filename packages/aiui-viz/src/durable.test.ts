// @vitest-environment jsdom
/**
 * durable.test.ts — the durable registry and durableSignal's stale-read guard
 * (write-semantics proposal M6): a boundary read that would return the
 * PRE-write value of something this same tick wrote is a named error at the
 * call site, not a silently wrong branch. The guard is value-aware, so every
 * legitimate pattern (setter's return, flush() then read, reads inside the
 * graph, same-value writes) stays silent.
 */
import { createEffect, createRoot, flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { disposeDurable, durable, durableSignal } from "./durable";

let keys: string[] = [];
const fresh = <T>(key: string, initial: Exclude<T, () => void>) => {
  keys.push(key);
  return durableSignal<T>(key, initial as never);
};
afterEach(() => {
  for (const key of keys) disposeDurable(key);
  keys = [];
  vi.restoreAllMocks();
});

describe("durable()", () => {
  it("creates once and adopts on every later call", () => {
    keys.push("t:box");
    const a = durable("t:box", () => ({ n: 1 }));
    const b = durable("t:box", () => ({ n: 2 })); // re-evaluated module adopts
    expect(b).toBe(a);
    expect(b.n).toBe(1);
  });
});

describe("durableSignal stale-read guard (M6)", () => {
  it("shouts when a boundary read returns the pre-write value of a same-tick write", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const phase = fresh<string>("t:phase", "disarmed");
    phase.set("armed" as never);
    const seen = phase.get(); // the classic bite: branch on a read-back
    expect(seen).toBe("disarmed"); // Solid semantics: stale
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0][0]).toMatch(/t:phase.*PRE-write/s);
  });

  it("stays silent after flush() — the committed read agrees with the write", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const phase = fresh<string>("t:phase2", "disarmed");
    phase.set("armed" as never);
    flush();
    expect(phase.get()).toBe("armed");
    expect(error).not.toHaveBeenCalled();
  });

  it("stays silent for reads INSIDE the reactive graph (they see staged values)", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const n = fresh<number>("t:n", 0);
    let observed = -1;
    const dispose = createRoot((dispose) => {
      createEffect(
        () => n.get(),
        (v) => {
          observed = v;
        },
      );
      return dispose;
    });
    flush();
    flush(() => n.set(5 as never));
    expect(observed).toBe(5);
    dispose();
    expect(error).not.toHaveBeenCalled();
  });

  it("stays silent on a same-value write (reading it back is harmless)", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const n = fresh<number>("t:same", 3);
    n.set(3 as never);
    expect(n.get()).toBe(3);
    expect(error).not.toHaveBeenCalled();
  });

  it("stays silent in the next tick — the flag clears once the write commits", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const n = fresh<number>("t:next", 0);
    n.set(1 as never);
    await Promise.resolve();
    expect(n.get()).toBe(1);
    expect(error).not.toHaveBeenCalled();
  });

  it("keeps Solid's updater composition — two set(v=>v+1) in one tick yield 2", () => {
    const n = fresh<number>("t:chain", 0);
    n.set(((v: number) => v + 1) as never);
    const written = n.set(((v: number) => v + 1) as never);
    expect(written).toBe(2); // the guard wrapper must not break pending resolution
  });
});
