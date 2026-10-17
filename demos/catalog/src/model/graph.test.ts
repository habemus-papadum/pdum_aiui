/**
 * graph.test.ts — the cells and the derived tools, headless: each control
 * moves the cells it should, the slow cell reports progress and fails on
 * demand, and the agent sees the surface the catalog page claims it does.
 */
import { agentToolkit, registerStandardTools } from "@habemus-papadum/aiui-viz";
import {
  type CellHarness,
  cellHarness,
  resetControlSurface,
  whenReady,
  whenState,
} from "@habemus-papadum/aiui-viz/testing";
import { afterEach, describe, expect, it } from "vitest";
import { buildCells, type CatalogCells } from "./graph";
import { appScope, breakSummary, damping, frequency, randomize, shape } from "./store";
import { waveSummary } from "./wave";

const q = (leaf: string) => appScope.qualify(leaf);

let h: CellHarness<CatalogCells> | undefined;
afterEach(() => {
  h?.dispose();
  h = undefined;
  resetControlSurface();
});

describe("the wave cells", () => {
  it("samples follow every control, with writes validated by the meta", async () => {
    h = cellHarness(buildCells);
    const first = await whenReady(h.cells.samples);
    expect(first).toHaveLength(240);

    expect(frequency.set(99)).toBe(4); // clamped by the control's own meta…
    const second = await whenReady(h.cells.samples);
    expect(second).not.toBe(first); // …and the cell noticed

    damping.set(0);
    const third = await whenReady(h.cells.samples);
    expect(waveSummary(third).rms).toBeGreaterThan(waveSummary(second).rms); // no decay

    shape.set("square");
    const fourth = await whenReady(h.cells.samples);
    expect(Math.abs(fourth[0].y)).toBe(1);
    expect(() => shape.set("sawtooth" as never)).toThrow();
  });

  it("the summary is slow, reports progress, keeps its last value, and fails on demand", async () => {
    h = cellHarness(buildCells);
    const s = await whenReady(h.cells.summary, { timeoutMs: 3000 });
    expect(s.crossings).toBeGreaterThan(0);
    expect(h.cells.summary.progress()).toBe(1);

    breakSummary.set(true);
    await whenState(h.cells.summary, "errored", { timeoutMs: 3000 });
    expect(String(h.cells.summary.error())).toMatch(/on request/);
    expect(h.cells.summary.latest()).toEqual(s); // the last good value survives
  });
});

describe("the agent's view", () => {
  it("report sees the surface, set drives it, the action is a tool with its doc comment", async () => {
    h = cellHarness(buildCells);
    await whenReady(h.cells.samples);

    const kit = agentToolkit("catalogTest");
    registerStandardTools(kit, { scopes: [appScope] });

    const brief = kit.handle().call("report") as {
      controls: Record<string, unknown>;
      actions: string[];
      cells: Record<string, string>;
      edges: Record<string, string[]>;
    };
    expect(brief.controls).toMatchObject({ [q("frequency")]: 1.5, [q("damping")]: 0.6 });
    expect(brief.actions).toContain(q("randomize"));
    expect(brief.cells).toMatchObject({ [q("samples")]: "ready" });
    expect(brief.edges[q("samples")]).toEqual([
      `control:${q("frequency")}`,
      `control:${q("damping")}`,
      `control:${q("shape")}`,
    ]);

    const full = kit.handle().call("report", { format: "full" }) as {
      controls: Array<{ name: string; description?: string }>;
    };
    expect(full.controls.find((c) => c.name === q("shape"))?.description).toBe(
      "The waveform under the envelope: a sine, a square or a triangle.",
    );
    expect(randomize.description).toBe("Jump the wave to a random frequency and damping.");

    const written = kit.handle().call("set", { name: q("frequency"), value: 0.01 }) as {
      value: number;
    };
    expect(written.value).toBe(0.5); // same clamp as the slider — one validation path

    const jumped = kit.handle().call(q("randomize")) as { frequency: number; damping: number };
    expect(jumped.frequency).toBeGreaterThanOrEqual(0.5);
    expect(jumped.frequency).toBeLessThanOrEqual(4);
    expect(jumped.damping).toBeLessThanOrEqual(2);
  });
});
