// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  agentToolkit,
  CellView,
  cell,
  cellGraph,
  disposeDurable,
  durable,
  workerStream,
} from "./index";

describe("@habemus-papadum/aiui-viz surface", () => {
  it("re-exports the core API as callables", () => {
    for (const fn of [
      cell,
      cellGraph,
      durable,
      disposeDurable,
      agentToolkit,
      workerStream,
      CellView,
    ]) {
      expect(typeof fn).toBe("function");
    }
  });

  it("cellGraph runs setup and hands back a disposer", () => {
    const { graph, dispose } = cellGraph(() => 42);
    expect(graph).toBe(42);
    expect(typeof dispose).toBe("function");
    dispose();
  });

  it("durable() creates once, adopts thereafter, and re-creates after disposal", () => {
    let calls = 0;
    const make = () => ({ n: ++calls });

    const a = durable("viz-smoke:x", make);
    const b = durable("viz-smoke:x", make);
    expect(a).toBe(b); // adopted, not re-created
    expect(calls).toBe(1);

    disposeDurable("viz-smoke:x");
    const c = durable("viz-smoke:x", make);
    expect(calls).toBe(2); // real teardown → next call creates fresh
    expect(c).not.toBe(a);
  });

  it("agentToolkit registration is idempotent by name", () => {
    const kit = agentToolkit("vizSmoke");
    let ran = 0;
    const ping = {
      name: "ping",
      description: "smoke tool",
      run: () => {
        ran += 1;
        return "pong";
      },
    };
    kit.registerTool(ping);
    kit.registerTool({ ...ping }); // same name replaces, does not duplicate

    const handle = kit.handle();
    expect(handle.tools.filter((t) => t.name === "ping")).toHaveLength(1);
    expect(handle.call("ping")).toBe("pong");
    expect(ran).toBe(1);

    kit.registerReporter("status", () => ({ ok: true }));
    expect((kit.handle().report() as Record<string, unknown>).status).toEqual({ ok: true });
  });
});
