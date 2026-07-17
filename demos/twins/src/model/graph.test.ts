/**
 * graph.test.ts — the composed app, headless (playbook layer 2 testing): two
 * slice instances driven through the DERIVED tool surface, exactly as an
 * agent would drive them. The slice's own unit tests live with the slice
 * (demos/oscillator); what belongs HERE is the composition — the
 * qualified surface, instance independence through the tools, and the
 * cross-instance lissajous cell.
 */
import { TRACE_SAMPLES } from "@habemus-papadum/aiui-oscillator";
import { resetControlSurface, tick, whenReady } from "@habemus-papadum/aiui-viz/testing";
import { afterEach, describe, expect, it } from "vitest";
import { graph } from "./graph";
import { left, right } from "./store";

/** The app's tool surface (window.__app — agentToolkit ns "app"). */
const call = (name: string, args?: Record<string, unknown>) => {
  const kit = (window as unknown as Record<string, { call(n: string, a?: unknown): unknown }>)
    .__app;
  if (!kit) throw new Error("agent toolkit not installed");
  return kit.call(name, args);
};

afterEach(async () => {
  resetControlSurface();
  await tick();
});

describe("the composed surface (what the agent sees)", () => {
  it("reports both instances' controls, cells, and actions under qualified names", () => {
    const report = call("report") as {
      controls: Record<string, unknown>;
      actions: string[];
      cells: Record<string, string>;
      edges: Record<string, string[]>;
    };
    expect(Object.keys(report.controls)).toEqual(
      expect.arrayContaining(["left/freq", "left/damping", "right/freq", "right/amp"]),
    );
    expect(report.actions).toEqual(expect.arrayContaining(["left/kick", "right/kick"]));
    expect(Object.keys(report.cells)).toEqual(
      expect.arrayContaining(["left/trace", "right/trace"]),
    );
    // The topology is instance-qualified: left/trace ← left/params ← left's controls.
    expect(report.edges["left/trace"]).toContain("cell:left/params");
    expect(report.edges["left/params"]).toContain("control:left/freq");
    expect(report.edges["left/params"]).not.toContain("control:right/freq");
  });

  it("the slice's identity survives the workspace boundary (dotdot locs)", () => {
    expect(left.freq.description).toMatch(/Natural frequency/);
    expect(left.freq.loc).toMatch(/oscillator\/src\/slice\.ts:\d+$/);
  });
});

describe("driving the instances through the derived tools", () => {
  it("set by qualified name moves ONE instance, validated by its own meta", async () => {
    const written = call("set", { name: "left/freq", value: 99 }) as { value: number };
    expect(written.value).toBe(5); // clamped by the slice's declared max
    await tick();
    expect(left.freq.get()).toBe(5);
    expect(right.freq.get()).toBe(1); // untouched

    const before = await whenReady(graph().rightTrace);
    call("set", { name: "left/amp", value: 2 });
    await whenReady(graph().leftTrace);
    expect(graph().rightTrace.latest()).toBe(before); // right never recomputed
  });

  it("each instance's kick is its own named tool", async () => {
    call("left/kick");
    await tick();
    expect(left.phase.get()).toBeCloseTo(Math.PI / 2);
    expect(right.phase.get()).toBe(0);
  });
});

describe("the composition cell", () => {
  it("lissajous interleaves both traces and follows either instance", async () => {
    const pairs = await whenReady(graph().lissajous);
    expect(pairs.length).toBe(TRACE_SAMPLES * 2);

    right.amp.set(2);
    const after = await whenReady(graph().lissajous);
    // y values (odd indices) grew with the right oscillator's amplitude.
    const maxY = (a: Float64Array) => Math.max(...a.filter((_, i) => i % 2 === 1));
    expect(maxY(after)).toBeGreaterThan(maxY(pairs));
  });
});
