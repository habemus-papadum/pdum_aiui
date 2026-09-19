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
      { ns: "app", tools: [expect.objectContaining({ name: "reset" })], active: true },
    ]);
    await expect(tools.call("app", "reset")).resolves.toBe("reset");
    await expect(tools.call("app", "zoom")).rejects.toThrow(/no such page tool/);
    off();
    tools.register("app", []);
    expect(changes).toBe(2); // unsubscribed
  });

  it("setActive flips the namespace bit, notifies, and survives re-registration", () => {
    const tools = ensureAiuiGlobal()?.tools;
    if (tools === undefined) {
      throw new Error("no registry");
    }
    let changes = 0;
    tools.onChange(() => changes++);
    tools.register("app", [{ name: "zoom", description: "zoom", run: () => "ok" }]);
    expect(tools.list()[0]?.active).toBe(true); // active by default

    tools.setActive("app", false);
    expect(tools.list()[0]?.active).toBe(false);
    expect(changes).toBe(2); // register + the flip
    tools.setActive("app", false); // idempotent — no notification
    expect(changes).toBe(2);

    // An HMR re-register must NOT re-activate a parked page.
    tools.register("app", [{ name: "zoom", description: "zoom", run: () => "ok" }]);
    expect(tools.list()[0]?.active).toBe(false);

    // …and the bit can be set BEFORE the namespace registers (route decided,
    // module still lazy-loading).
    tools.setActive("late", false);
    tools.register("late", [{ name: "go", description: "go", run: () => "ok" }]);
    expect(tools.list().find((e) => e.ns === "late")?.active).toBe(false);
  });

  it("ledger flattens to one row per (ns, tool) with activity riding along", () => {
    const tools = ensureAiuiGlobal()?.tools;
    if (tools === undefined) {
      throw new Error("no registry");
    }
    tools.register("a", [{ name: "x", description: "dx", run: () => 0 }]);
    tools.register("b", [
      { name: "y", description: "dy", run: () => 0 },
      { name: "z", description: "dz", run: () => 0 },
    ]);
    tools.setActive("b", false);
    expect(tools.ledger()).toEqual([
      { ns: "a", tool: "x", description: "dx", active: true },
      { ns: "b", tool: "y", description: "dy", active: false },
      { ns: "b", tool: "z", description: "dz", active: false },
    ]);
  });

  it("carries the tool document: usage + kind per tool, a brief per namespace", () => {
    const tools = ensureAiuiGlobal()?.tools;
    if (tools === undefined) {
      throw new Error("no registry");
    }
    tools.register(
      "app",
      [
        {
          name: "sql",
          description: "run SQL",
          usage: "aggregate in SQL",
          kind: "read",
          run: () => 0,
        },
        { name: "reset", description: "reset", run: () => 0 },
      ],
      { brief: "An earthquake catalog." },
    );
    expect(tools.list()).toEqual([
      {
        ns: "app",
        active: true,
        brief: "An earthquake catalog.",
        tools: [
          expect.objectContaining({ name: "sql", usage: "aggregate in SQL", kind: "read" }),
          expect.objectContaining({ name: "reset" }),
        ],
      },
    ]);
    expect(tools.ledger()).toEqual([
      {
        ns: "app",
        tool: "sql",
        description: "run SQL",
        active: true,
        kind: "read",
        usage: "aggregate in SQL",
      },
      { ns: "app", tool: "reset", description: "reset", active: true },
    ]);
    // The brief is part of the declaration: a re-register without one drops it.
    tools.register("app", [{ name: "reset", description: "reset", run: () => 0 }]);
    expect(tools.list()[0]?.brief).toBeUndefined();
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

  it("a kit's brief reaches the registry, and a re-created kit replaces it (HMR)", () => {
    const kit = agentToolkit("briefed", { brief: "v1" });
    kit.registerTool({ name: "t", description: "d", run: () => 0 });
    const tools = ensureAiuiGlobal()?.tools;
    expect(tools?.list().find((e) => e.ns === "briefed")?.brief).toBe("v1");
    // The module re-evaluates: same namespace, new brief, same handle.
    const again = agentToolkit("briefed", { brief: "v2" });
    again.registerTool({ name: "t", description: "d", run: () => 0 });
    expect(tools?.list().find((e) => e.ns === "briefed")?.brief).toBe("v2");
    // A kit created without a brief keeps the namespace's current one.
    agentToolkit("briefed").registerTool({ name: "u", description: "d", run: () => 0 });
    expect(tools?.list().find((e) => e.ns === "briefed")?.brief).toBe("v2");
  });
});
