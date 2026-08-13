// @vitest-environment jsdom
/**
 * mosaic-facet.test.ts — component adoption over a REAL mosaic-core
 * Selection: voice writes drive the component's own publish path (one
 * clause, the component's source, visual moved), mouse publishes mirror
 * into the dim quietly, adoption hands off from/to the headless clause on
 * register/unregister, 2-D adoption defers until scales exist, transforms
 * bridge value spaces, and paired dims share one interactor without staged-
 * read hazards.
 */
import { clauseInterval, clauseIntervals, Selection } from "@uwdata/mosaic-core";
import { column } from "@uwdata/mosaic-sql";
import { afterEach, describe, expect, it } from "vitest";
import { clearControlSurface } from "./control";
import { disposeDurable } from "./durable";
import { bindSelectionComponents } from "./mosaic-facet";
import {
  clearMosaicProducerRegistry,
  registerMosaicInput,
  registerMosaicPlot,
} from "./mosaic-registry";
import { clearSelectionDimRegistry, type IntervalValue, selectionDim } from "./mosaic-selection";
import { scope } from "./scope";
import { tick } from "./testing";

let disposers: (() => void)[] = [];
afterEach(() => {
  for (const d of disposers) d();
  disposers = [];
  clearMosaicProducerRegistry();
  disposeDurable("mosaic-producers:registry");
  for (const key of clearSelectionDimRegistry().durableKeys) disposeDurable(key);
  for (const key of clearControlSurface().durableKeys) disposeDurable(key);
});

const fx = () => scope("fx");

function fakeInterval1D(selection: object, field = "mag") {
  const moves: unknown[] = [];
  const iv = {
    selection,
    field,
    channel: "x",
    brush: { moveSilent: "MOVE" },
    g: {
      call: (_fn: unknown, arg: unknown) => {
        moves.push(arg);
      },
    },
    scale: { apply: (v: number) => v * 10 },
    mark: { plot: { markSet: new Set([{}]) } },
    value: undefined as unknown,
  };
  return { iv, moves };
}

function fakeInterval2D(selection: object, withScales: boolean) {
  const moves: unknown[] = [];
  const iv = {
    selection,
    xfield: "eq_x",
    yfield: "eq_y",
    brush: { moveSilent: "MOVE" },
    g: {
      call: (_fn: unknown, arg: unknown) => {
        moves.push(arg);
      },
    },
    ...(withScales
      ? {
          xscale: { apply: (v: number) => v * 10 },
          yscale: { apply: (v: number) => 1000 - v * 10 },
        }
      : {}),
    pixelSize: 1,
    mark: { plot: { markSet: new Set([{}]) } },
    value: undefined as unknown,
  };
  return { iv, moves };
}

const dimClause = (sel: Selection, name: string) =>
  sel.clauses.find((c) => String((c.source as { name?: unknown })?.name ?? "").startsWith(name));

describe("interval adoption", () => {
  it("voice drives the component: one clause from ITS source, visual moved, headless retracted", async () => {
    const sel = Selection.crossfilter();
    const mag = selectionDim({
      name: "mag",
      scope: fx(),
      kind: "interval",
      targets: [{ selection: sel, field: "mag" }],
    });
    // Filter set BEFORE any component exists: headless clause.
    mag.set({ lo: 5, hi: 6 });
    await tick();
    const { dispose } = bindSelectionComponents({
      bindings: [{ dim: mag, producer: "fx/hist" }],
    });
    disposers.push(dispose);
    expect(dimClause(sel, "dim:fx/mag")).toBeDefined();

    // Component appears: the clause hands off to it, the rectangle draws.
    const { iv, moves } = fakeInterval1D(sel);
    disposers.push(registerMosaicPlot({ scope: "fx", name: "hist", plot: { interactors: [iv] } }));
    await tick();
    expect(sel.clauses).toHaveLength(1);
    expect(sel.clauses[0].source).toBe(iv);
    expect(sel.clauses[0].value).toEqual([5, 6]);
    expect(iv.value).toEqual([5, 6]);
    expect(moves.at(-1)).toEqual([50, 60]);

    // A later voice set REPLACES (same source), never stacks.
    mag.set({ lo: 7, hi: 8 });
    await tick();
    expect(sel.clauses).toHaveLength(1);
    expect(sel.clauses[0].value).toEqual([7, 8]);
    expect(moves.at(-1)).toEqual([70, 80]);
  });

  it("one-sided ranges publish gte/lte through the component and clear the rectangle", async () => {
    const sel = Selection.crossfilter();
    const mag = selectionDim({
      name: "mag",
      scope: fx(),
      kind: "interval",
      targets: [{ selection: sel, field: "mag" }],
    });
    const { iv, moves } = fakeInterval1D(sel);
    disposers.push(registerMosaicPlot({ scope: "fx", name: "hist", plot: { interactors: [iv] } }));
    const { dispose } = bindSelectionComponents({
      bindings: [{ dim: mag, producer: "fx/hist" }],
    });
    disposers.push(dispose);

    mag.set({ lo: 7 });
    await tick();
    expect(sel.clauses).toHaveLength(1);
    expect(sel.clauses[0].source).toBe(iv);
    expect(String(sel.clauses[0].predicate)).toContain(">= 7");
    expect(moves.at(-1)).toBeNull(); // no honest rectangle for a half-open range
  });

  it("mouse publishes mirror into the dim quietly; reset clears it", async () => {
    const sel = Selection.crossfilter();
    const mag = selectionDim({
      name: "mag",
      scope: fx(),
      kind: "interval",
      targets: [{ selection: sel, field: "mag" }],
    });
    const { iv } = fakeInterval1D(sel);
    disposers.push(registerMosaicPlot({ scope: "fx", name: "hist", plot: { interactors: [iv] } }));
    const { dispose } = bindSelectionComponents({
      bindings: [{ dim: mag, producer: "fx/hist" }],
    });
    disposers.push(dispose);

    sel.update(clauseInterval(column("mag"), [7, 8] as never, { source: iv }));
    await tick();
    expect(mag.get()).toEqual({ lo: 7, hi: 8 });
    expect(sel.clauses).toHaveLength(1); // mirroring never republishes

    sel.reset();
    await tick();
    expect(mag.get()).toBeNull();
  });

  it("release re-publishes headless so the filter survives a component teardown", async () => {
    const sel = Selection.crossfilter();
    const mag = selectionDim({
      name: "mag",
      scope: fx(),
      kind: "interval",
      targets: [{ selection: sel, field: "mag" }],
    });
    const { iv } = fakeInterval1D(sel);
    const unregister = registerMosaicPlot({
      scope: "fx",
      name: "hist",
      plot: { interactors: [iv] },
    });
    const { dispose } = bindSelectionComponents({
      bindings: [{ dim: mag, producer: "fx/hist" }],
    });
    disposers.push(dispose);
    mag.set({ lo: 5, hi: 6 });
    await tick();

    // Teardown, in MosaicView's real cleanup order: unregister FIRST (the
    // binding republishes headless), THEN ghost protection retracts the dead
    // component's clause. The filter must survive the gap — this is what
    // makes a brush outlive a theme-flip rebuild.
    unregister();
    const stale = sel.clauses.find((c) => c.source === iv);
    if (stale !== undefined) sel.update({ ...stale, value: null, predicate: null } as never);
    await tick();
    expect(mag.get()).toEqual({ lo: 5, hi: 6 });
    const headless = dimClause(sel, "dim:fx/mag");
    expect(headless).toBeDefined();
    expect(headless?.value).toEqual([5, 6]);
  });

  it("transforms bridge value spaces (years ↔ dates)", async () => {
    const sel = Selection.crossfilter();
    const year = selectionDim({
      name: "year",
      scope: fx(),
      kind: "interval",
      targets: [{ selection: sel, field: "year" }],
    });
    const { iv } = fakeInterval1D(sel, "time");
    (iv.scale as { apply: unknown }).apply = (v: Date) => v.getTime() / 1e10;
    disposers.push(registerMosaicPlot({ scope: "fx", name: "time", plot: { interactors: [iv] } }));
    const { dispose } = bindSelectionComponents({
      bindings: [
        {
          dim: year,
          producer: "fx/time",
          to: (v: IntervalValue) =>
            v == null
              ? null
              : [
                  v.lo != null ? new Date(Date.UTC(v.lo, 0, 1)) : null,
                  v.hi != null ? new Date(Date.UTC(v.hi + 1, 0, 1) - 1) : null,
                ],
          from: (cv) => {
            if (cv == null || !Array.isArray(cv)) return null;
            const yr = (x: unknown) =>
              x instanceof Date ? x.getUTCFullYear() : new Date(x as number).getUTCFullYear();
            return { lo: yr(cv[0]), hi: yr(cv[1]) };
          },
        },
      ],
    });
    disposers.push(dispose);

    year.set({ lo: 2010, hi: 2012 });
    await tick();
    expect(sel.clauses[0].source).toBe(iv);
    const [a, b] = sel.clauses[0].value as [Date, Date];
    expect(a.getUTCFullYear()).toBe(2010);
    expect(b.getUTCFullYear()).toBe(2012);

    // Mouse drags an arbitrary date range: the dim reports whole years.
    sel.update(
      clauseInterval(
        column("time"),
        [new Date(Date.UTC(2004, 5, 1)), new Date(Date.UTC(2005, 8, 1))] as never,
        {
          source: iv,
        },
      ),
    );
    await tick();
    expect(year.get()).toEqual({ lo: 2004, hi: 2005 });
  });
});

describe("paired 2-D adoption", () => {
  const to = (a: unknown, b: unknown) => {
    const lon = a as IntervalValue;
    const lat = b as IntervalValue;
    if (lon == null && lat == null) return null;
    return [
      [(lon?.lo ?? -180) * 2, (lon?.hi ?? 180) * 2],
      [(lat?.lo ?? -90) * 3, (lat?.hi ?? 90) * 3],
    ];
  };
  const from = (cv: unknown): [IntervalValue, IntervalValue] => {
    if (cv == null || !Array.isArray(cv)) return [null, null];
    const [xr, yr] = cv as [number[], number[]];
    return [
      { lo: xr[0] / 2, hi: xr[1] / 2 },
      { lo: yr[0] / 3, hi: yr[1] / 3 },
    ];
  };

  function declarePair(sel: Selection) {
    const lon = selectionDim({
      name: "lon",
      scope: fx(),
      kind: "interval",
      targets: [{ selection: sel, field: "eq_x" }],
    });
    const lat = selectionDim({
      name: "lat",
      scope: fx(),
      kind: "interval",
      targets: [{ selection: sel, field: "eq_y" }],
    });
    return { lon, lat };
  }

  it("two dims drive one interactor jointly (shadow state, no staged reads)", async () => {
    const sel = Selection.crossfilter();
    const { lon, lat } = declarePair(sel);
    const { iv, moves } = fakeInterval2D(sel, true);
    disposers.push(registerMosaicPlot({ scope: "fx", name: "map", plot: { interactors: [iv] } }));
    const { dispose } = bindSelectionComponents({
      bindings: [{ dims: [lon, lat], producer: "fx/map", to, from }],
    });
    disposers.push(dispose);

    // Same-tick sequential sets (the load-view shape): the second must see
    // the first through the shadow, not a staled box read.
    lon.set({ lo: 10, hi: 20 });
    lat.set({ lo: 0, hi: 30 });
    await tick();
    expect(sel.clauses).toHaveLength(1);
    expect(sel.clauses[0].source).toBe(iv);
    expect(sel.clauses[0].value).toEqual([
      [20, 40],
      [0, 90],
    ]);
    // d3 corner pairs [[x0,y0],[x1,y1]], normalized: y scale inverts, so
    // lat 90 → pixel 100 and lat 0 → pixel 1000.
    expect(moves.at(-1)).toEqual([
      [200, 100],
      [400, 1000],
    ]);

    // Mouse box mirrors into BOTH dims.
    sel.update(
      clauseIntervals(
        [column("eq_x"), column("eq_y")],
        [
          [2, 4],
          [3, 6],
        ] as never,
        {
          source: iv,
        },
      ),
    );
    await tick();
    expect(lon.get()).toEqual({ lo: 1, hi: 2 });
    expect(lat.get()).toEqual({ lo: 1, hi: 2 });
  });

  it("defers the 2-D publish until scales exist (headless holds the filter)", async () => {
    const sel = Selection.crossfilter();
    const { lon, lat } = declarePair(sel);
    const { iv } = fakeInterval2D(sel, false);
    disposers.push(registerMosaicPlot({ scope: "fx", name: "map", plot: { interactors: [iv] } }));
    const { dispose } = bindSelectionComponents({
      bindings: [{ dims: [lon, lat], producer: "fx/map", to, from }],
    });
    disposers.push(dispose);

    lon.set({ lo: 10, hi: 20 });
    await tick();
    // Not driveable yet: the headless clauses still filter; value seeded.
    expect(sel.clauses.every((c) => c.source !== iv)).toBe(true);
    expect(iv.value).toEqual([
      [20, 40],
      [-270, 270],
    ]);

    // Scales arrive (a render happened): the deferred publish lands.
    (iv as { xscale?: unknown }).xscale = { apply: (v: number) => v };
    (iv as { yscale?: unknown }).yscale = { apply: (v: number) => v };
    await new Promise((res) => setTimeout(res, 130));
    await tick();
    expect(sel.clauses).toHaveLength(1);
    expect(sel.clauses[0].source).toBe(iv);
  });
});

describe("point adoption (menu)", () => {
  it("drives the menu visual and publishes from the menu's source", async () => {
    const sel = Selection.crossfilter();
    const type = selectionDim({
      name: "type",
      scope: fx(),
      kind: "point",
      targets: [{ selection: sel, field: "type" }],
    });
    const picked: unknown[] = [];
    const menu = {
      selection: sel,
      field: "type",
      selectedValue: (v: unknown) => {
        picked.push(v);
      },
    };
    disposers.push(
      registerMosaicInput({ scope: "fx", name: "type-menu", input: menu, selection: sel }),
    );
    const { dispose } = bindSelectionComponents({
      bindings: [{ dim: type, producer: "fx/type-menu" }],
    });
    disposers.push(dispose);

    type.set(["earthquake"]);
    await tick();
    expect(picked.at(-1)).toBe("earthquake");
    expect(sel.clauses).toHaveLength(1);
    expect(sel.clauses[0].source).toBe(menu);
    expect(String(sel.clauses[0].predicate)).toContain("earthquake");

    type.clear();
    await tick();
    expect(picked.at(-1)).toBe("");
    expect(sel.clauses).toHaveLength(0);
  });
});

describe("dispose", () => {
  it("restores plain headless behavior", async () => {
    const sel = Selection.crossfilter();
    const mag = selectionDim({
      name: "mag",
      scope: fx(),
      kind: "interval",
      targets: [{ selection: sel, field: "mag" }],
    });
    const { iv } = fakeInterval1D(sel);
    disposers.push(registerMosaicPlot({ scope: "fx", name: "hist", plot: { interactors: [iv] } }));
    const binder = bindSelectionComponents({ bindings: [{ dim: mag, producer: "fx/hist" }] });
    binder.dispose();

    mag.set({ lo: 5 });
    await tick();
    expect(dimClause(sel, "dim:fx/mag")).toBeDefined();
    expect(sel.clauses.every((c) => c.source !== iv)).toBe(true);
  });
});
