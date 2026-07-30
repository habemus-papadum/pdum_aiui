/**
 * page-tools.test.ts — the panel's LOCAL view of the driven page's tools
 * (O3b). The rules that matter are the ones two independent consumers of one
 * page-event stream can get wrong: whose `toolsResult` is whose, and what
 * happens when a page never answers.
 */

import { describe, expect, it, vi } from "vitest";
import { type FakeBus, fakeBus } from "./fake-bus";
import { createPageTools, type PageToolsRegistry } from "./page-tools";

const settle = async (rounds = 8): Promise<void> => {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
  }
};

const register = (bus: FakeBus, tab: number, tools: string[], ns = "app"): void => {
  bus.firePageEvent({
    kind: "pageTools",
    tab,
    registrations:
      tools.length === 0
        ? []
        : [{ ns, tools: tools.map((name) => ({ name, description: `${name} does a thing` })) }],
  });
};

/** The callId the registry issued for its pending call, read off the bus log. */
const issuedCallId = (bus: FakeBus): string => {
  const line = bus.log.filter((l) => l.includes("toolsCall")).at(-1) ?? "";
  return (JSON.parse(line.slice(line.indexOf("{"))) as { callId: string }).callId;
};

describe("the page-tools registry", () => {
  const rig = (): { bus: FakeBus; registry: PageToolsRegistry } => {
    const bus = fakeBus({ activeTab: 7 });
    return { bus, registry: createPageTools({ host: bus, timeoutMs: 50 }) };
  };

  it("holds the tab's registrations, replaces them wholesale, and forgets an empty set", () => {
    const { bus, registry } = rig();
    expect(registry.toolsFor(7)).toEqual([]);

    register(bus, 7, ["set_freq", "kick"]);
    expect(registry.toolsFor(7).flatMap((n) => n.tools.map((t) => t.name))).toEqual([
      "set_freq",
      "kick",
    ]);

    // The event carries the FULL current set, so a smaller one is a replace,
    // never a merge.
    register(bus, 7, ["kick"]);
    expect(registry.toolsFor(7).flatMap((n) => n.tools.map((t) => t.name))).toEqual(["kick"]);

    register(bus, 7, []);
    expect(registry.toolsFor(7)).toEqual([]);
  });

  it("keeps tabs apart — a background tab's tools are never the tab in view's", () => {
    const { bus, registry } = rig();
    register(bus, 7, ["a"]);
    register(bus, 9, ["b"]);
    expect(registry.toolsFor(7).flatMap((n) => n.tools.map((t) => t.name))).toEqual(["a"]);
    expect(registry.toolsFor(9).flatMap((n) => n.tools.map((t) => t.name))).toEqual(["b"]);
    expect(registry.toolsFor(undefined)).toEqual([]);
  });

  it("announces every change so a live projection can follow it", () => {
    const { bus, registry } = rig();
    let changes = 0;
    const off = registry.onChange(() => changes++);
    register(bus, 7, ["a"]);
    register(bus, 7, ["a", "b"]);
    register(bus, 7, []);
    expect(changes).toBe(3);
    off();
    register(bus, 7, ["c"]);
    expect(changes).toBe(3);
  });

  it("calls through the page and resolves on the correlated result", async () => {
    const { bus, registry } = rig();
    register(bus, 7, ["kick"]);
    const answer = registry.call(7, "app", "kick", { force: 2 });
    await settle();
    const callId = issuedCallId(bus);
    bus.firePageEvent({ kind: "toolsResult", tab: 7, callId, ok: true, value: { applied: 2 } });
    await expect(answer).resolves.toEqual({ applied: 2 });
  });

  it("rejects on a tool that failed — an error the model can read, not a hang", async () => {
    const { bus, registry } = rig();
    register(bus, 7, ["kick"]);
    const answer = registry.call(7, "app", "kick", {});
    await settle();
    bus.firePageEvent({
      kind: "toolsResult",
      tab: 7,
      callId: issuedCallId(bus),
      ok: false,
      error: "no such control",
    });
    await expect(answer).rejects.toThrow("no such control");
  });

  it("IGNORES a result it did not issue — the directory's calls are not ours", async () => {
    const { bus, registry } = rig();
    register(bus, 7, ["kick"]);
    const answer = registry.call(7, "app", "kick", {});
    await settle();
    // tools-link (the channel directory's half) issues its own callIds on the
    // same page and hears every result, exactly as we do. A stray one must not
    // settle our promise.
    bus.firePageEvent({ kind: "toolsResult", tab: 7, callId: "someone-else", ok: true, value: 1 });
    await settle();
    bus.firePageEvent({
      kind: "toolsResult",
      tab: 7,
      callId: issuedCallId(bus),
      ok: true,
      value: "ours",
    });
    await expect(answer).resolves.toBe("ours");
  });

  it("gives up on a page that never answers — a voice turn cannot wait forever", async () => {
    vi.useFakeTimers();
    try {
      const { bus, registry } = rig();
      register(bus, 7, ["kick"]);
      const answer = registry.call(7, "app", "kick", {});
      const assertion = expect(answer).rejects.toThrow("did not answer");
      await vi.advanceTimersByTimeAsync(60);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("dispose rejects what is still in flight and stops listening", async () => {
    const { bus, registry } = rig();
    register(bus, 7, ["kick"]);
    const answer = registry.call(7, "app", "kick", {});
    const assertion = expect(answer).rejects.toThrow("the panel closed");
    registry.dispose();
    await assertion;
    register(bus, 7, ["late"]);
    expect(registry.toolsFor(7)).toEqual([]);
  });
});
