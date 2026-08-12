// @vitest-environment jsdom
/**
 * mosaic-selection.test.ts — declared cross-filter dimensions over Mosaic
 * Selections: publication/replacement/retraction against the REAL pinned
 * mosaic-core Selection (the behaviors the module docblock claims are
 * verified here, not assumed), validation, durability across re-declaration
 * (the HMR shape), the derived set-<name> action, and the Selection→signal
 * read-back bridge.
 */
import { Selection } from "@uwdata/mosaic-core";
import { sql } from "@uwdata/mosaic-sql";
import { afterEach, describe, expect, it } from "vitest";
import { actionByName, clearControlSurface } from "./control";
import { disposeDurable } from "./durable";
import {
  clearAllSelectionDims,
  clearSelectionDimRegistry,
  type SelectionClauseLike,
  selectionDim,
  selectionDimReport,
  selectionDimSurface,
  selectionPredicateSql,
  selectionSignal,
} from "./mosaic-selection";
import { scope } from "./scope";
import { tick } from "./testing";

afterEach(() => {
  for (const key of clearSelectionDimRegistry().durableKeys) disposeDurable(key);
  for (const key of clearControlSurface().durableKeys) disposeDurable(key);
});

const sqlOf = (sel: Selection): string[] => sel.clauses.map((c) => String(c.predicate));

describe("selectionDim: identity and declaration", () => {
  it("throws loudly without a name — the compiler or the pedantic form must supply it", () => {
    const sel = Selection.crossfilter();
    expect(() =>
      selectionDim({ kind: "interval", targets: [{ selection: sel, field: "mag" }] }),
    ).toThrow(/needs a name/);
  });

  it("requires at least one target", () => {
    expect(() => selectionDim({ name: "mag", kind: "interval", targets: [] })).toThrow(
      /at least one target/,
    );
  });

  it("scope-qualifies the identity and enrolls in the surface snapshot", () => {
    const s = scope("selx");
    const sel = Selection.crossfilter();
    selectionDim({
      name: "mag",
      scope: s,
      kind: "interval",
      description: "Magnitude window",
      targets: [{ selection: sel, field: "mag", table: "quakes" }],
    });
    const [entry] = selectionDimSurface(s);
    expect(entry).toMatchObject({
      name: "selx/mag",
      kind: "interval",
      scope: "selx",
      description: "Magnitude window",
      value: null,
      targets: [{ table: "quakes", field: "mag" }],
    });
  });
});

describe("selectionDim: publication against a real Selection", () => {
  it("a two-sided set publishes one BETWEEN clause; a re-set REPLACES it (stable source)", () => {
    const sel = Selection.crossfilter();
    const dim = selectionDim({
      name: "mag",
      kind: "interval",
      targets: [{ selection: sel, field: "mag" }],
    });
    expect(dim.set({ lo: 5, hi: 6 })).toEqual({ lo: 5, hi: 6 });
    expect(sel.clauses).toHaveLength(1);
    expect(sqlOf(sel)[0]).toContain("BETWEEN");
    dim.set({ lo: 4, hi: 7 });
    expect(sel.clauses).toHaveLength(1); // replaced, never stacked
    expect(sqlOf(sel)[0]).toContain("4");
  });

  it("one-sided sets build >= / <= predicates (mosaic only knows BETWEEN)", () => {
    const sel = Selection.crossfilter();
    const dim = selectionDim({
      name: "depth",
      kind: "interval",
      targets: [{ selection: sel, field: "depth" }],
    });
    dim.set({ lo: 70 });
    expect(sqlOf(sel)[0]).toContain(">=");
    dim.set({ hi: 300 });
    expect(sel.clauses).toHaveLength(1);
    expect(sqlOf(sel)[0]).toContain("<=");
  });

  it("clear() retracts the clause from the Selection; {} and null clear too", () => {
    const sel = Selection.crossfilter();
    const dim = selectionDim({
      name: "mag",
      kind: "interval",
      targets: [{ selection: sel, field: "mag" }],
    });
    dim.set({ lo: 5, hi: 6 });
    expect(sel.clauses).toHaveLength(1);
    expect(dim.clear()).toBeNull();
    expect(sel.clauses).toHaveLength(0);
    dim.set({ lo: 5 });
    expect(dim.set({})).toBeNull(); // no sides = no filter
    expect(sel.clauses).toHaveLength(0);
  });

  it("a point dim publishes membership; [] means no filter (mosaic's own reading)", () => {
    const sel = Selection.crossfilter();
    const dim = selectionDim({
      name: "type",
      kind: "point",
      options: ["earthquake", "nuclear explosion"],
      targets: [{ selection: sel, field: "type" }],
    });
    dim.set(["earthquake"]);
    expect(sel.clauses).toHaveLength(1);
    expect(sqlOf(sel)[0]).toContain("earthquake");
    expect(dim.set([])).toBeNull();
    expect(sel.clauses).toHaveLength(0);
  });

  it("fans one semantic value out to per-table targets, expressions included", () => {
    const selA = Selection.crossfilter();
    const selB = Selection.crossfilter();
    const dim = selectionDim({
      name: "time",
      kind: "interval",
      targets: [
        { selection: selA, field: "ts", table: "turns" },
        { selection: selB, field: sql`epoch_ms(started_at)`, table: "sessions" },
      ],
    });
    dim.set({ lo: 100, hi: 200 });
    expect(selA.clauses).toHaveLength(1);
    expect(selB.clauses).toHaveLength(1);
    expect(sqlOf(selA)[0]).toContain("ts");
    expect(sqlOf(selB)[0]).toContain("epoch_ms");
    dim.clear();
    expect(selA.clauses).toHaveLength(0);
    expect(selB.clauses).toHaveLength(0);
  });

  it("an external Selection.reset() nulls the semantic value (the source hook)", async () => {
    const sel = Selection.crossfilter();
    const dim = selectionDim({
      name: "mag",
      kind: "interval",
      targets: [{ selection: sel, field: "mag" }],
    });
    dim.set({ lo: 5, hi: 6 });
    await tick();
    sel.reset();
    await tick();
    expect(dim.get()).toBeNull();
    expect(sel.clauses).toHaveLength(0);
  });
});

describe("selectionDim: validation (one place, every writer)", () => {
  it("clamps to declared min/max and returns the APPLIED value", () => {
    const sel = Selection.crossfilter();
    const dim = selectionDim({
      name: "mag",
      kind: "interval",
      min: 0,
      max: 10,
      targets: [{ selection: sel, field: "mag" }],
    });
    expect(dim.set({ lo: -5, hi: 99 })).toEqual({ lo: 0, hi: 10 });
  });

  it("throws on lo > hi and on non-finite numbers", () => {
    const sel = Selection.crossfilter();
    const dim = selectionDim({
      name: "mag",
      kind: "interval",
      targets: [{ selection: sel, field: "mag" }],
    });
    expect(() => dim.set({ lo: 6, hi: 5 })).toThrow(/must be ≤/);
    expect(() => dim.set({ lo: Number.NaN })).toThrow(/finite number/);
    expect(sel.clauses).toHaveLength(0); // a rejected write publishes nothing
  });

  it("point options are enums: a write outside the set throws with the legal list", () => {
    const sel = Selection.crossfilter();
    const dim = selectionDim({
      name: "type",
      kind: "point",
      options: ["shallow", "deep"],
      targets: [{ selection: sel, field: "depth_class" }],
    });
    expect(() => dim.set(["abyssal"])).toThrow(/"shallow", "deep"/);
  });
});

describe("selectionDim: durability across re-declaration (the HMR shape)", () => {
  it("adopts the existing value and keeps the clause source stable", async () => {
    const sel = Selection.crossfilter();
    const declare = () =>
      selectionDim({
        name: "mag",
        kind: "interval",
        targets: [{ selection: sel, field: "mag" }],
      });
    const first = declare();
    first.set({ lo: 5, hi: 6 });
    await tick();

    const second = declare(); // module re-evaluates
    expect(second.get()).toEqual({ lo: 5, hi: 6 }); // NOT reset
    second.set({ lo: 4, hi: 7 });
    expect(sel.clauses).toHaveLength(1); // same durable source: replaced, not stacked
  });
});

describe("selectionDim: the derived set-<name> action", () => {
  it("registers a real schema'd action whose run sets, clamps, and clears", () => {
    const s = scope("selx");
    const sel = Selection.crossfilter();
    selectionDim({
      name: "mag",
      scope: s,
      kind: "interval",
      min: 0,
      max: 10,
      targets: [{ selection: sel, field: "mag", table: "quakes" }],
    });
    const a = actionByName("selx/set-mag");
    expect(a).toBeDefined();
    expect(a?.description).toContain("quakes.mag");
    const schema = a?.inputSchema as { properties: Record<string, Record<string, unknown>> };
    expect(schema.properties.lo).toMatchObject({ type: "number", minimum: 0, maximum: 10 });

    expect(a?.run?.({ lo: -3, hi: 8 })).toEqual({ name: "selx/mag", applied: { lo: 0, hi: 8 } });
    expect(sel.clauses).toHaveLength(1);
    expect(a?.run?.({ clear: true })).toEqual({ name: "selx/mag", applied: null });
    expect(sel.clauses).toHaveLength(0);
    expect(() => a?.run?.({})).toThrow(/lo and\/or hi/);
  });

  it("a point dim's action carries the options as an enum and applies values", () => {
    const s = scope("selx");
    const sel = Selection.crossfilter();
    selectionDim({
      name: "type",
      scope: s,
      kind: "point",
      options: ["earthquake", "eruption"],
      targets: [{ selection: sel, field: "type" }],
    });
    const a = actionByName("selx/set-type");
    const schema = a?.inputSchema as {
      properties: { values: { items: { enum?: unknown[] } } };
    };
    expect(schema.properties.values.items.enum).toEqual(["earthquake", "eruption"]);
    expect(a?.run?.({ values: ["eruption"] })).toEqual({
      name: "selx/type",
      applied: ["eruption"],
    });
    expect(sel.clauses).toHaveLength(1);
  });
});

describe("the report surface and the scope-wide clear", () => {
  it("selectionDimReport includes inactive dims (null tells the agent it EXISTS)", async () => {
    const s = scope("selx");
    const sel = Selection.crossfilter();
    const mag = selectionDim({
      name: "mag",
      scope: s,
      kind: "interval",
      targets: [{ selection: sel, field: "mag" }],
    });
    selectionDim({
      name: "type",
      scope: s,
      kind: "point",
      targets: [{ selection: sel, field: "type" }],
    });
    mag.set({ lo: 5 });
    await tick(); // writes are staged — report() reads after a task boundary
    expect(selectionDimReport(s)).toEqual({ "selx/mag": { lo: 5 }, "selx/type": null });

    clearAllSelectionDims(s);
    await tick();
    expect(sel.clauses).toHaveLength(0);
    expect(selectionDimReport(s)).toEqual({ "selx/mag": null, "selx/type": null });
  });

  it("a scope filter keeps a sibling app's dims out (and unscoped ones in)", () => {
    const sel = Selection.crossfilter();
    selectionDim({
      name: "mag",
      scope: scope("a"),
      kind: "interval",
      targets: [{ selection: sel, field: "mag" }],
    });
    selectionDim({
      name: "year",
      scope: scope("b"),
      kind: "interval",
      targets: [{ selection: sel, field: "year" }],
    });
    selectionDim({
      name: "global",
      kind: "interval",
      targets: [{ selection: sel, field: "g" }],
    });
    expect(Object.keys(selectionDimReport("a"))).toEqual(["a/mag", "global"]);
  });
});

describe("selectionSignal: the Selection → Solid read-back bridge", () => {
  it("bumps on every value event, from ANY producer, and derives sql()", async () => {
    const sel = Selection.crossfilter();
    const sig = selectionSignal(sel);
    const dim = selectionDim({
      name: "mag",
      kind: "interval",
      targets: [{ selection: sel, field: "mag" }],
    });
    await tick();
    const v0 = sig.version();
    expect(sig.active()).toBe(false);
    expect(sig.sql()).toBe("TRUE");

    dim.set({ lo: 5, hi: 6 });
    await tick();
    expect(sig.version()).toBeGreaterThan(v0);
    expect(sig.active()).toBe(true);
    expect(sig.sql()).toContain("BETWEEN");

    dim.clear();
    await tick();
    expect(sig.sql()).toBe("TRUE");

    const after = sig.version();
    sig.dispose();
    dim.set({ lo: 1 });
    await tick();
    expect(sig.version()).toBe(after); // disposed: no more bumps
  });

  it("selectionPredicateSql falls back to the clause list on structural fakes", () => {
    const clauses: SelectionClauseLike[] = [
      { source: {}, value: [1, 2], predicate: { toString: () => '("x" BETWEEN 1 AND 2)' } },
      { source: {}, value: "a", predicate: { toString: () => "(\"t\" = 'a')" } },
    ];
    const fake = {
      update: () => fake,
      clauses,
      addEventListener: () => {},
      removeEventListener: () => {},
    };
    expect(selectionPredicateSql(fake)).toBe('("x" BETWEEN 1 AND 2) AND ("t" = \'a\')');
  });
});
