/**
 * reactive.test.ts — sttSignals over a scripted handle: status tracks,
 * partial follows the CUMULATIVE delta and is cleared only by ITS segment's
 * final (a newer segment may already be streaming), finals append in
 * arrival order, lastError clears on progress.
 */
import { describe, expect, it } from "vitest";
import { sttSignals } from "./reactive";
import type { SttHandle } from "./stt";
import type { SttEvent } from "./types";

function scriptedHandle() {
  const listeners = new Set<(event: SttEvent) => void>();
  const handle = {
    status: () => "idle",
    subscribe(listener: (event: SttEvent) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as SttHandle;
  const push = (event: SttEvent): void => {
    for (const listener of listeners) {
      listener(event);
    }
  };
  return { handle, push, listeners };
}

// Solid 2.0's signals core applies writes on the microtask flush — reads
// straight after a write see the previous value, so every assert waits a tick.
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("sttSignals", () => {
  it("tracks status, partial, finals", async () => {
    const { handle, push } = scriptedHandle();
    const signals = sttSignals(handle);
    expect(signals.status()).toBe("idle");
    expect(signals.partial()).toBeUndefined();

    push({ type: "status", status: "ready" });
    await tick();
    expect(signals.status()).toBe("ready");

    push({ type: "delta", segment: 0, text: "hel" });
    push({ type: "delta", segment: 0, text: "hello" });
    await tick();
    expect(signals.partial()).toEqual({ segment: 0, text: "hello" });

    push({ type: "final", segment: 0, result: { text: "hello", latencyMs: 12, model: "m" } });
    await tick();
    expect(signals.partial()).toBeUndefined();
    expect(signals.finals()).toEqual([{ segment: 0, text: "hello", latencyMs: 12, model: "m" }]);
  });

  it("a final clears only ITS OWN segment's partial", async () => {
    const { handle, push } = scriptedHandle();
    const signals = sttSignals(handle);
    push({ type: "delta", segment: 0, text: "first" });
    // Segment 1 already streams while 0's final is still in flight.
    push({ type: "delta", segment: 1, text: "second" });
    await tick();
    push({ type: "final", segment: 0, result: { text: "first", latencyMs: 5, model: "m" } });
    await tick();
    expect(signals.partial()).toEqual({ segment: 1, text: "second" });
  });

  it("lastError sets on error and clears on the next progress", async () => {
    const { handle, push } = scriptedHandle();
    const signals = sttSignals(handle);
    push({ type: "error", message: "boom", segment: 2 });
    await tick();
    expect(signals.lastError()).toEqual({ message: "boom", segment: 2 });
    push({ type: "delta", segment: 3, text: "recovered" });
    await tick();
    expect(signals.lastError()).toBeUndefined();
  });

  it("dispose unsubscribes; signals keep their last values", async () => {
    const { handle, push, listeners } = scriptedHandle();
    const signals = sttSignals(handle);
    push({ type: "delta", segment: 0, text: "kept" });
    await tick();
    signals.dispose();
    expect(listeners.size).toBe(0);
    push({ type: "delta", segment: 0, text: "unseen" });
    await tick();
    expect(signals.partial()).toEqual({ segment: 0, text: "kept" });
  });
});
