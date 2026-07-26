// @vitest-environment jsdom
/**
 * The bridge projections: ControlMeta → JSON Schema synthesis (the projection
 * the repo lacked), the validated-write contract (the RETURNED value is the
 * truth — snapped and clamped, never read back), and the generic registry
 * wrap. Controls carry explicit names — no aiui compiler under Vitest.
 */
import { action, control, ensureAiuiGlobal } from "@habemus-papadum/aiui-viz";
import { describe, expect, it } from "vitest";
import { toolsFromAiuiRegistry, toolsFromControlSurface } from "./aiui-tools";
import type { OracleTool } from "./types";

// Module-global registries — declare once, filter per test by prefix.
const freq = control({
  name: "orlab/freq",
  value: 2,
  min: 0.5,
  max: 8,
  step: 0.5,
  unit: "Hz",
  description: "wave frequency",
});
control({ name: "orlab/wave", value: "sine", options: ["sine", "square"] });
control({ name: "orlab/grid", value: false, description: "show the grid" });
const kicked: unknown[] = [];
action({
  name: "orlab/kick",
  description: "give the wave a kick",
  run: (args) => {
    kicked.push(args);
    return "kicked";
  },
});
void freq;

const ours = () => toolsFromControlSurface({ filter: (entry) => entry.name.startsWith("orlab/") });

const byName = (tools: OracleTool[], name: string) => {
  const tool = tools.find((t) => t.name === name);
  if (tool === undefined) {
    throw new Error(`missing tool ${name}: ${tools.map((t) => t.name).join(", ")}`);
  }
  return tool;
};

describe("toolsFromControlSurface", () => {
  it("synthesizes bounds into the schema — enum, min/max, 0-anchored multipleOf", () => {
    const tools = ours();
    const value = (name: string) =>
      (byName(tools, name).parameters as { properties: { value: Record<string, unknown> } })
        .properties.value;
    // min 0.5 is NOT a multiple of step 0.5 anchored at 0? It is (0.5 % 0.5 === 0).
    expect(value("set_orlab_freq")).toEqual({
      type: "number",
      minimum: 0.5,
      maximum: 8,
      multipleOf: 0.5,
    });
    expect(value("set_orlab_wave")).toEqual({ enum: ["sine", "square"] });
    expect(value("set_orlab_grid")).toEqual({ type: "boolean" });
    expect(byName(tools, "set_orlab_freq").description).toContain("range 0.5–8 Hz");
  });

  it("a set call runs the validated setter and answers with the APPLIED value", async () => {
    const tools = ours();
    // 3.14 snaps to the 0.5 step (anchored at min) → 3; 99 clamps to max 8.
    expect(await byName(tools, "set_orlab_freq").execute({ value: 3.14 })).toEqual({ applied: 3 });
    expect(await byName(tools, "set_orlab_freq").execute({ value: 99 })).toEqual({ applied: 8 });
    // Outside the options vocabulary the control THROWS — in-band for the model.
    await expect(async () =>
      byName(tools, "set_orlab_wave").execute({ value: "triangle" }),
    ).rejects.toThrow();
  });

  it("actions become tools, and report snapshots values + bounds", async () => {
    const tools = ours();
    expect(await byName(tools, "orlab_kick").execute({ hard: true })).toBe("kicked");
    expect(kicked.at(-1)).toEqual({ hard: true });
    const report = (await byName(tools, "report").execute({})) as Array<Record<string, unknown>>;
    const grid = report.find((r) => r.control === "orlab/grid");
    expect(grid?.value).toBe(false);
  });
});

describe("toolsFromAiuiRegistry", () => {
  it("wraps registrations and routes calls through registry.call", async () => {
    const registry = ensureAiuiGlobal().tools;
    registry.register("orbridge", [
      {
        name: "hello",
        description: "says hello",
        inputSchema: { type: "object", properties: { who: { type: "string" } } },
        run: (args) => `hello ${(args as { who?: string } | undefined)?.who ?? "?"}`,
      },
    ]);
    const tools = toolsFromAiuiRegistry({ namespaces: ["orbridge"] });
    expect(tools).toBeDefined();
    const hello = byName(tools ?? [], "hello");
    expect(hello.parameters).toEqual({ type: "object", properties: { who: { type: "string" } } });
    expect(await hello.execute({ who: "oracle" })).toBe("hello oracle");
  });
});
