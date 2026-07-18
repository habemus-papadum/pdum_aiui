// @vitest-environment jsdom
/**
 * aiui-global.test.ts — the always-on `window.__AIUI__` (the 2026-07-14
 * plugin restructure): the global exists with NO plugin and NO dev server —
 * the production shape — and its tools half is a callable REGISTRY serving
 * in-page internal clients and the intent client's bridge alike.
 */
import { afterEach, describe, expect, it } from "vitest";
import { agentToolkit } from "./agent-tools";
import { ensureAiuiGlobal } from "./aiui-global";

afterEach(() => {
  (window as unknown as { __AIUI__?: unknown }).__AIUI__ = undefined;
  for (const key of Object.keys(window)) {
    if (key.startsWith("__")) {
      delete (window as unknown as Record<string, unknown>)[key];
    }
  }
});

describe("ensureAiuiGlobal", () => {
  it("installs the global + registry on a bare page (production, no plugin)", () => {
    const g = ensureAiuiGlobal();
    expect(g?.v).toBe(1);
    expect(g?.tools).toBeDefined();
    expect(ensureAiuiGlobal()).toBe(g); // idempotent — same object
  });

  it("respects an EXISTING tools surface (the old overlay's ws bridge)", () => {
    const bridge = { register: () => {} };
    (window as unknown as { __AIUI__?: unknown }).__AIUI__ = { v: 1, tools: bridge };
    expect(ensureAiuiGlobal()?.tools).toBe(bridge);
  });
});

describe("the tools registry", () => {
  it("register is replace-by-namespace; list and call serve any client", async () => {
    const tools = ensureAiuiGlobal()?.tools;
    if (tools === undefined) {
      throw new Error("no registry");
    }
    let changes = 0;
    const off = tools.onChange(() => changes++);

    tools.register("app", [
      {
        name: "zoom",
        description: "zoom the plot",
        run: (args) => `zoomed:${JSON.stringify(args)}`,
      },
    ]);
    tools.register("app", [{ name: "reset", description: "reset the view", run: () => "reset" }]);
    expect(changes).toBe(2);
    expect(tools.list()).toEqual([
      { ns: "app", tools: [expect.objectContaining({ name: "reset" })] },
    ]);
    await expect(tools.call("app", "reset")).resolves.toBe("reset");
    await expect(tools.call("app", "zoom")).rejects.toThrow(/no such page tool/);
    off();
    tools.register("app", []);
    expect(changes).toBe(2); // unsubscribed
  });

  it("agentToolkit lands in the registry with NO overlay anywhere (the prod path)", async () => {
    const kit = agentToolkit("plotapp");
    kit.registerTool({
      name: "set_range",
      description: "set the x range",
      run: () => "ok",
    });
    kit.registerReporter("range", () => ({ x: [0, 1] }));

    const tools = ensureAiuiGlobal()?.tools;
    const ns = tools?.list().find((entry) => entry.ns === "plotapp");
    expect(ns).toBeDefined();
    expect(ns?.tools.map((t) => t.name)).toEqual(expect.arrayContaining(["set_range", "report"]));
    // The registry is CALLABLE in-page — the internal-client door.
    await expect(tools?.call("plotapp", "set_range")).resolves.toBe("ok");
    const report = (await tools?.call("plotapp", "report")) as Record<string, unknown>;
    expect(report.range).toEqual({ x: [0, 1] });
  });
});
