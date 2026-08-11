// @vitest-environment jsdom
/**
 * bridge-effect.test.ts — the airlock contract.
 *
 * A bridge handler's sync throw must be RECORDED, not escalated (an uncaught
 * effect-phase throw halts the whole reactive system since 2.0.0-beta.32),
 * and the bridge must stay alive to deliver the next change. The registry is
 * the agent-visible half of the contract: named bridges register like cells
 * and report their failure history.
 */
import { createRoot, createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type BridgeEffectOptions,
  bridgeByName,
  bridgeEffect,
  bridgeRegistry,
} from "./bridge-effect";
import { scope } from "./scope";

const tick = () => new Promise((r) => setTimeout(r, 0));

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
});

function bridged(opts?: BridgeEffectOptions) {
  const [n, setN] = createSignal(0);
  const delivered: Array<[number, number | undefined]> = [];
  createRoot((d) => {
    dispose = d;
    bridgeEffect(
      n,
      (value, prev) => {
        if (value === 13) throw new Error("unlucky crossing");
        delivered.push([value, prev]);
      },
      opts,
    );
  });
  return { setN, delivered };
}

describe("bridgeEffect", () => {
  it("survives a handler throw and keeps delivering, with prev intact", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { setN, delivered } = bridged({ name: "sim-params" });
      await tick();
      expect(delivered).toEqual([[0, undefined]]);

      setN(13); // the crossing fails — recorded, not escalated
      await tick();
      expect(delivered.length).toBe(1);
      expect(errSpy).toHaveBeenCalledOnce();

      // The bridge is still alive, and prev advanced through the failure:
      // the compute produced 13 whether or not the handler delivered it.
      setN(2);
      await tick();
      expect(delivered).toEqual([
        [0, undefined],
        [2, 13],
      ]);

      const entry = bridgeByName("sim-params");
      expect(entry?.errorCount).toBe(1);
      expect(entry?.lastError).toContain("unlucky crossing");
    } finally {
      errSpy.mockRestore();
    }
  });

  it("registers scope-qualified, reports through the registry, deregisters on dispose", async () => {
    const s = scope("twin");
    bridged({ name: "feed", scope: s, loc: "src/model/graph.ts:7" });
    await tick();
    const entry = bridgeRegistry().find((b) => b.name === s.qualify("feed"));
    expect(entry).toBeDefined();
    expect(entry?.loc).toBe("src/model/graph.ts:7");
    expect(entry?.errorCount).toBe(0);

    dispose?.();
    dispose = undefined;
    expect(bridgeRegistry().find((b) => b.name === s.qualify("feed"))).toBeUndefined();
  });

  it("anonymous bridges are hardened but unregistered", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const before = bridgeRegistry().length;
      const { setN, delivered } = bridged();
      await tick();
      expect(bridgeRegistry().length).toBe(before);

      setN(13);
      await tick();
      setN(4);
      await tick();
      expect(delivered.at(-1)).toEqual([4, 13]);
    } finally {
      errSpy.mockRestore();
    }
  });

  it("routes failures to onError after recording", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const seen: unknown[] = [];
      const { setN } = bridged({ name: "hooked", onError: (e) => seen.push(e) });
      await tick();
      setN(13);
      await tick();
      expect(seen).toHaveLength(1);
      expect(String(seen[0])).toContain("unlucky crossing");
      expect(bridgeByName("hooked")?.errorCount).toBe(1);
    } finally {
      errSpy.mockRestore();
    }
  });
});
