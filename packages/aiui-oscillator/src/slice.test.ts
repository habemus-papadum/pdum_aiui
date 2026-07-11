/**
 * slice.test.ts — the slice as its consumers use it: two instances under two
 * scopes, headless. Identity (names, descriptions, package-qualified locs)
 * comes from the aiui compiler running in THIS package's own vite config —
 * which is itself half of what these tests pin: a slice's identity must not
 * depend on who compiles it.
 */
// @vitest-environment jsdom
import { actionByName, controlByName, dependencyEdges, scope } from "@habemus-papadum/aiui-viz";
import { cellHarness, tick, whenReady } from "@habemus-papadum/aiui-viz/testing";
import { afterEach, describe, expect, it } from "vitest";
import { displacementAt, oscillatorTrace } from "./oscillator";
import { oscillatorCells, oscillatorStore, TRACE_SAMPLES } from "./slice";

let h: ReturnType<typeof cellHarness> | undefined;
afterEach(() => {
  h?.dispose();
  h = undefined;
});

// Distinct scope names per test: controls are module-global and durable, so
// reusing a name across tests would adopt the previous test's state.
let stamp = 0;
const pair = () => {
  stamp++;
  return { left: scope(`l${stamp}`), right: scope(`r${stamp}`) };
};

describe("oscillator math (layer 1)", () => {
  it("starts at amp·sin(phase) and decays under damping", () => {
    const p = { freq: 1, damping: 0.5, amp: 2, phase: Math.PI / 2 };
    expect(displacementAt(p, 0)).toBeCloseTo(2);
    const early = Math.abs(displacementAt(p, 0.25));
    const late = Math.abs(displacementAt(p, 2.25));
    expect(late).toBeLessThan(early);
  });

  it("zero damping preserves the envelope across whole periods", () => {
    const p = { freq: 1, damping: 0, amp: 1.5, phase: Math.PI / 2 };
    expect(displacementAt(p, 3)).toBeCloseTo(displacementAt(p, 0), 6);
  });

  it("samples the requested window", () => {
    const trace = oscillatorTrace({ freq: 1, damping: 0, amp: 1, phase: 0 }, 4, 64);
    expect(trace).toHaveLength(64);
    expect(trace[0]).toBeCloseTo(0);
  });
});

describe("the slice's compiled identity (this package's own toolchain)", () => {
  it("controls carry injected leaf names, descriptions, and package-qualified locs", () => {
    const { left } = pair();
    const store = oscillatorStore(left);
    expect(store.freq.name).toBe(`${left.name}/freq`);
    expect(store.freq.scope).toBe(left.name);
    expect(store.freq.description).toMatch(/Natural frequency/);
    expect(store.freq.loc).toMatch(/^@habemus-papadum\/aiui-oscillator\/src\/slice\.ts:\d+$/);
    expect(store.kick.name).toBe(`${left.name}/kick`);
    expect(store.kick.description).toMatch(/quarter-turn phase impulse/);
  });
});

describe("two instances (the reason scopes exist)", () => {
  it("have independent controls, durable state, and kick actions", async () => {
    const { left, right } = pair();
    const l = oscillatorStore(left);
    const r = oscillatorStore(right);

    l.freq.set(3);
    expect(r.freq.get()).toBe(1); // no shared box
    expect(controlByName(`${right.name}/freq`)).toBe(r.freq);

    actionByName(`${left.name}/kick`)?.run();
    await tick();
    expect(l.phase.get()).toBeCloseTo(Math.PI / 2);
    expect(r.phase.get()).toBe(0); // the other instance was not kicked
  });

  it("cells register qualified and recompute only for their own instance", async () => {
    const { left, right } = pair();
    const l = oscillatorStore(left);
    const r = oscillatorStore(right);
    let cells!: { lt: ReturnType<typeof oscillatorCells>; rt: ReturnType<typeof oscillatorCells> };
    h = cellHarness(() => {
      cells = { lt: oscillatorCells(left, l), rt: oscillatorCells(right, r) };
      return { a: cells.lt.trace, b: cells.rt.trace };
    });

    const before = await whenReady(cells.rt.trace);
    expect(cells.lt.trace.cellName).toBe(`${left.name}/trace`);
    expect((await whenReady(cells.lt.trace)).length).toBe(TRACE_SAMPLES);

    l.amp.set(2);
    const after = await whenReady(cells.lt.trace);
    expect(Math.max(...after)).toBeGreaterThan(1.5);
    expect(cells.rt.trace.latest()).toBe(before); // right never recomputed

    // The dependency topology is instance-qualified: left/trace reads
    // left/params, which reads only left's controls.
    const edges = Object.fromEntries(dependencyEdges().map((e) => [e.cell, e.reads]));
    expect(edges[`${left.name}/trace`]).toEqual([{ kind: "cell", name: `${left.name}/params` }]);
    const paramReads = edges[`${left.name}/params`].map((x) => x.name);
    expect(paramReads).toContain(`${left.name}/freq`);
    expect(paramReads).not.toContain(`${right.name}/freq`);
  });
});
