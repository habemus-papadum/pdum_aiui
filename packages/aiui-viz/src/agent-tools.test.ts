// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { agentToolkit } from "./agent-tools";

/** A recording stand-in for the overlay's `window.__AIUI__.tools` bridge. */
function installFakeBridge() {
  const calls: Array<{
    ns: string;
    tools: Array<{
      name: string;
      description: string;
      inputSchema?: unknown;
      run: (a?: unknown) => unknown;
    }>;
  }> = [];
  (window as unknown as { __AIUI__?: { tools?: unknown } }).__AIUI__ = {
    tools: { register: (ns: string, tools: never[]) => calls.push({ ns, tools }) },
  };
  return { calls, latest: () => calls[calls.length - 1] };
}

afterEach(() => {
  (window as unknown as { __AIUI__?: unknown }).__AIUI__ = undefined;
  for (const key of Object.keys(window)) {
    if (key.startsWith("__")) {
      delete (window as unknown as Record<string, unknown>)[key];
    }
  }
});

describe("agentToolkit → overlay forwarding", () => {
  it("does nothing (and never throws) without an overlay bridge", () => {
    const kit = agentToolkit("noverlay");
    expect(() => kit.registerTool({ name: "t", description: "d", run: () => 1 })).not.toThrow();
  });

  it("forwards described tools plus a synthetic report tool", () => {
    const bridge = installFakeBridge();
    const kit = agentToolkit("morpho");
    kit.registerReporter("state", () => ({ n: 1 }));
    kit.registerTool({
      name: "set-params",
      description: "set params",
      inputSchema: { type: "object" },
      run: () => "ok",
    });

    const latest = bridge.latest();
    expect(latest.ns).toBe("morpho");
    const byName = new Map(latest.tools.map((t) => [t.name, t]));
    expect(byName.get("set-params")).toMatchObject({
      description: "set params",
      inputSchema: { type: "object" },
    });
    // The synthetic report tool wraps report() and runs it live.
    const report = byName.get("report");
    expect(report?.description).toBe("bounded snapshot of page state");
    expect(report?.run()).toEqual({ state: { n: 1 } });
  });

  it("skips tools without a description", () => {
    const bridge = installFakeBridge();
    const kit = agentToolkit("aztec");
    kit.registerTool({ name: "described", description: "keep", run: () => 1 });
    kit.registerTool({ name: "bare", description: "", run: () => 2 });

    const names = bridge.latest().tools.map((t) => t.name);
    expect(names).toContain("described");
    expect(names).not.toContain("bare");
    expect(names).toContain("report");
  });

  it("forwards the current set again when the bridge announces itself late", () => {
    // Register before any overlay exists…
    const kit = agentToolkit("late");
    kit.registerTool({ name: "t", description: "d", run: () => 1 });

    // …then the overlay installs and fires its ready event.
    const bridge = installFakeBridge();
    document.dispatchEvent(new CustomEvent("aiui:tools-ready"));

    const forwarded = bridge.calls.find((c) => c.ns === "late");
    expect(forwarded).toBeDefined();
    expect(forwarded?.tools.map((t) => t.name)).toContain("t");
  });

  it("forwards the newest run after a tool is re-registered (HMR swap)", () => {
    const bridge = installFakeBridge();
    const kit = agentToolkit("swap");
    kit.registerTool({ name: "t", description: "d", run: () => "v1" });
    kit.registerTool({ name: "t", description: "d", run: () => "v2" });

    const t = bridge.latest().tools.find((x) => x.name === "t");
    expect(t?.run()).toBe("v2");
  });
});
