import { createEffect, createRoot } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import { liveSignal } from "./live-signal";

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("liveSignal (read-your-own-writes)", () => {
  const disposers: Array<() => void> = [];
  afterEach(() => {
    for (const d of disposers.splice(0)) {
      d();
    }
  });

  it("reads back a same-tick write — the whole point", () => {
    const phase = liveSignal<"idle" | "armed" | "turn">("idle");
    phase.set("armed");
    // A plain createSignal would still say "idle" here (Solid 2.0 batches);
    // machine logic branching on it would silently take the wrong arm.
    expect(phase.get()).toBe("armed");
    phase.set("turn");
    expect(phase.get()).toBe("turn");
  });

  it("chains functional updates against the CURRENT value in one tick", () => {
    const n = liveSignal(0);
    n.set((v) => v + 1);
    n.set((v) => v + 1);
    expect(n.get()).toBe(2);
  });

  it("set returns what was written", () => {
    const s = liveSignal("a");
    expect(s.set("b")).toBe("b");
    expect(s.set((prev) => `${prev}!`)).toBe("b!");
  });

  it("still drives reactive scopes, and identical writes stay silent", async () => {
    const flag = liveSignal(false);
    const seen: boolean[] = [];
    createRoot((dispose) => {
      disposers.push(dispose);
      createEffect(
        () => flag.get(),
        (value) => {
          seen.push(value);
        },
      );
    });
    await tick();
    expect(seen).toEqual([false]);

    flag.set(true);
    await tick();
    expect(seen).toEqual([false, true]);

    flag.set(true); // === current — no notification
    await tick();
    expect(seen).toEqual([false, true]);
  });
});
