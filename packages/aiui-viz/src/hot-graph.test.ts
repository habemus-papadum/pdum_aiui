// @vitest-environment jsdom
import { createEffect, createRoot, onCleanup } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { disposeDurable, durableSignal } from "./durable";
import { type HotContext, hotCellGraph } from "./hot-graph";

/** hotCellGraph namespaces its box; clean it between tests. */
function forget(key: string): void {
  disposeDurable(`aiui:graph:${key}`);
}

describe("durableSignal", () => {
  afterEach(() => disposeDurable("t:count"));

  it("creates once and adopts thereafter, keeping the written value", async () => {
    const first = durableSignal("t:count", 1);
    first.set(7);
    // Solid 2.0 commits writes transactionally: a same-tick get() still reads
    // the pre-write value. Cross a tick, as a real app's event handler does.
    await Promise.resolve();

    // A re-evaluated module calls durableSignal again with the same key.
    const second = durableSignal("t:count", 1);

    expect(second).toBe(first); // adopted, not re-created
    expect(second.get()).toBe(7); // NOT reset to the initial value
  });

  it("re-creates after a real teardown", () => {
    durableSignal("t:count", 1).set(7);
    disposeDurable("t:count");
    expect(durableSignal("t:count", 1).get()).toBe(1);
  });
});

describe("hotCellGraph", () => {
  afterEach(() => forget("test"));

  it("builds the graph and returns a defined accessor", () => {
    const graph = hotCellGraph("test", () => ({ answer: 42 }));
    expect(graph().answer).toBe(42);
  });

  it("disposes the previous graph before building the next", () => {
    const disposed: string[] = [];
    const build = (tag: string) => () => {
      onCleanup(() => disposed.push(tag));
      return { tag };
    };

    const first = hotCellGraph("test", build("a"));
    expect(first().tag).toBe("a");
    expect(disposed).toEqual([]);

    // A hot edit: the module re-evaluates and calls hotCellGraph again.
    const second = hotCellGraph("test", build("b"));
    expect(disposed).toEqual(["a"]); // the old graph's owner was torn down
    expect(second().tag).toBe("b");
  });

  it("serves the new graph through an accessor captured before the swap", () => {
    const graph = hotCellGraph("test", () => ({ tag: "a" }));
    hotCellGraph("test", () => ({ tag: "b" }));
    // The UI holds the ORIGINAL accessor across a hot swap — it must not be
    // pinned to the disposed graph. This is why components read graph().x.
    expect(graph().tag).toBe("b");
  });

  it("notifies reactive consumers when the graph is swapped", () => {
    const seen: string[] = [];
    const dispose = createRoot((d) => {
      const graph = hotCellGraph("test", () => ({ tag: "a" }));
      createEffect(
        () => graph().tag,
        (tag) => {
          seen.push(tag); // braces: an effect handler must return a cleanup or undefined
        },
      );
      return d;
    });
    // Effects are deferred; flush by awaiting a microtask boundary.
    return Promise.resolve().then(() => {
      hotCellGraph("test", () => ({ tag: "b" }));
      return Promise.resolve().then(() => {
        expect(seen).toEqual(["a", "b"]);
        dispose();
      });
    });
  });

  it("self-accepts when handed a hot context, and works without one", () => {
    const hot: HotContext = { accept: vi.fn() };
    hotCellGraph("test", () => ({ tag: "a" }), hot);
    expect(hot.accept).toHaveBeenCalledTimes(1);
    expect(hot.accept).toHaveBeenCalledWith(); // bare self-accept, no callback

    forget("test");
    expect(() => hotCellGraph("test", () => ({ tag: "a" }), undefined)).not.toThrow();
  });

  it("keeps graphs under different keys independent", () => {
    const a = hotCellGraph("test", () => ({ tag: "a" }));
    const b = hotCellGraph("other", () => ({ tag: "b" }));
    expect(a().tag).toBe("a");
    expect(b().tag).toBe("b");
    forget("other");
  });
});
