/**
 * scope.test.ts — instance identity for composable slices: the double-
 * instantiation problem (two instances from ONE call site silently sharing
 * one durable state) and its fix. The tests play the slice-factory pattern
 * straight: leaf names written explicitly here stand in for what the compiler
 * injects at the (single) call site.
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { type Cell, cell } from "./cell";
import { action, actionByName, clearControlSurface, control, controlByName } from "./control";
import { disposeDurable } from "./durable";
import { dependencyEdges, resetDependencyEdges } from "./graph-trace";
import { type Scope, scope } from "./scope";
import { cellHarness, tick, whenReady } from "./testing";

let h: ReturnType<typeof cellHarness> | undefined;

afterEach(() => {
  h?.dispose();
  h = undefined;
  const { durableKeys } = clearControlSurface();
  for (const key of durableKeys) {
    disposeDurable(key);
  }
  resetDependencyEdges();
});

/** A miniature slice factory: what a library would export. The explicit
 * `name` stands in for the compiler's injected leaf. */
function makeOsc(s: Scope) {
  const freq = control({ scope: s, name: "freq", value: 1, min: 0.1, max: 5, step: 0.1 });
  const reset = action({ scope: s, name: "reset", run: () => freq.set(1) });
  return { freq, reset };
}

describe("scope handles", () => {
  it("qualifies names and nests via child()", () => {
    const s = scope("left");
    expect(s.name).toBe("left");
    expect(s.qualify("freq")).toBe("left/freq");
    expect(s.child("osc").qualify("freq")).toBe("left/osc/freq");
  });

  it("rejects empty, whitespace, and separator-abusing segments", () => {
    expect(() => scope("")).toThrow(/non-empty/);
    expect(() => scope("a b")).toThrow(/whitespace/);
    expect(() => scope("/a")).toThrow(/start or end/);
    expect(() => scope("left").qualify("")).toThrow(/non-empty/);
  });

  it("scoped durable keys are instance-distinct", () => {
    const left = scope("left").durableSignal("phase", 0);
    const right = scope("right").durableSignal("phase", 0);
    left.set(3);
    expect(right.get()).toBe(0);
    disposeDurable("left/phase");
    disposeDurable("right/phase");
  });
});

describe("two instances of one slice", () => {
  it("get distinct controls with distinct durable state (the silent-sharing fix)", () => {
    const left = makeOsc(scope("left"));
    const right = makeOsc(scope("right"));

    expect(left.freq.name).toBe("left/freq");
    expect(right.freq.name).toBe("right/freq");
    expect(left.freq.scope).toBe("left");

    left.freq.set(3);
    expect(right.freq.get()).toBe(1); // no shared box
    expect(controlByName("left/freq")).toBe(left.freq);
    expect(controlByName("right/freq")).toBe(right.freq);
  });

  it("get distinct action tools, each driving its own instance", async () => {
    const left = makeOsc(scope("left"));
    const right = makeOsc(scope("right"));
    left.freq.set(4);
    right.freq.set(2);
    await tick();

    expect(actionByName("left/reset")?.scope).toBe("left");
    actionByName("left/reset")?.run();
    await tick();
    expect(left.freq.get()).toBe(1);
    expect(right.freq.get()).toBe(2); // untouched
  });

  it("scoped cells register under qualified names and record qualified edges", async () => {
    const left = makeOsc(scope("left"));
    const right = makeOsc(scope("right"));

    let cells!: { l: Cell<number>; r: Cell<number> };
    h = cellHarness(() => {
      // What a cells factory does: one call site, per-instance scope option.
      const build = (s: Scope, freq: (typeof left)["freq"]) =>
        cell(
          () => ({ f: freq.get() }),
          ({ f }) => f * 2,
          { scope: s, name: "wave" },
        );
      cells = { l: build(scope("left"), left.freq), r: build(scope("right"), right.freq) };
      return cells;
    });

    expect(await whenReady(cells.l)).toBe(2);
    expect(cells.l.cellName).toBe("left/wave");
    expect(cells.r.cellName).toBe("right/wave");

    left.freq.set(3);
    expect(await whenReady(cells.l)).toBe(6);
    expect(cells.r.latest()).toBe(2); // the other instance did not recompute

    const edges = Object.fromEntries(dependencyEdges().map((e) => [e.cell, e.reads]));
    expect(edges["left/wave"]).toEqual([{ kind: "control", name: "left/freq" }]);
    expect(edges["right/wave"]).toEqual([{ kind: "control", name: "right/freq" }]);
  });

  it("unscoped declarations are unchanged (leaf name IS the identity)", () => {
    const solo = control({ name: "solo", value: 5 });
    expect(solo.name).toBe("solo");
    expect(solo.scope).toBeUndefined();
  });
});
