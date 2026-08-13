// @vitest-environment jsdom
/**
 * mosaic-registry.test.ts — the producer directory: interactor
 * classification (duck-typed against the mosaic-plot 0.28 property shapes),
 * plot/input registration and naming, replace-by-name on re-render, the
 * "still mine?" unregister guard, scoped listing, and the published-first
 * value read.
 */
import { afterEach, describe, expect, it } from "vitest";
import { disposeDurable } from "./durable";
import {
  clearMosaicProducerRegistry,
  introspectInteractor,
  mosaicProducers,
  registerMosaicInput,
  registerMosaicPlot,
} from "./mosaic-registry";
import { scope } from "./scope";

afterEach(() => {
  clearMosaicProducerRegistry();
  disposeDurable("mosaic-producers:registry");
});

function fakeSelection() {
  const published: { source: object; value: unknown }[] = [];
  return {
    published,
    valueFor(source: object) {
      return published.find((c) => c.source === source)?.value;
    },
  };
}

// The property shapes the classifier pins (mosaic-plot 0.28 constructors).
const interval1d = (selection: object, field: unknown = "mag") => ({
  selection,
  field,
  channel: "x",
  brush: {},
  value: undefined as unknown,
});
const interval2d = (selection: object) => ({
  selection,
  xfield: "eq_x",
  yfield: "eq_y",
  brush: {},
});
const toggle = (selection: object) => ({
  selection,
  fields: [{ column: "depth_class" }],
  as: ["depth_class"],
});
const panzoom = () => ({ xsel: {}, ysel: {}, xfield: "x", yfield: "y" });
const highlight = (selection: object) => ({ selection, channels: [["opacity", 0.2]] });

describe("introspectInteractor", () => {
  it("classifies the publishing shapes and reads their columns", () => {
    const sel = fakeSelection();
    expect(introspectInteractor(interval1d(sel))).toMatchObject({
      kind: "interval",
      fields: ["mag"],
    });
    expect(introspectInteractor(interval2d(sel))).toMatchObject({
      kind: "interval",
      fields: ["eq_x", "eq_y"],
    });
    // Toggle fields arrive as ExprNodes — the column name is unwrapped.
    expect(introspectInteractor(toggle(sel))).toMatchObject({
      kind: "point",
      fields: ["depth_class"],
    });
  });

  it("skips non-publishers: PanZoom (no .selection) and Highlight (no fields)", () => {
    expect(introspectInteractor(panzoom())).toBeUndefined();
    expect(introspectInteractor(highlight(fakeSelection()))).toBeUndefined();
  });
});

describe("registerMosaicPlot", () => {
  it("names a single publisher bare, several with :index, and includes legend handlers", () => {
    const sel = fakeSelection();
    const s = scope("rx");
    registerMosaicPlot({ scope: s, name: "map", plot: { interactors: [interval2d(sel)] } });
    registerMosaicPlot({
      scope: s,
      name: "hist",
      plot: {
        interactors: [interval1d(sel), panzoom()],
        legends: [{ legend: { handler: toggle(sel) } }],
      },
    });
    const names = mosaicProducers(s).map((e) => e.name);
    expect(names).toEqual(["rx/hist:0", "rx/hist:1", "rx/map"]);
    const legend = mosaicProducers(s).find((e) => e.name === "rx/hist:1");
    expect(legend?.fields).toEqual(["depth_class"]);
  });

  it("replaces by name on re-registration, and a stale unregister never evicts the successor", () => {
    const sel = fakeSelection();
    const s = scope("rx");
    const first = interval1d(sel, "mag");
    const second = interval1d(sel, "mag");
    const unregisterFirst = registerMosaicPlot({
      scope: s,
      name: "hist",
      plot: { interactors: [first] },
    });
    const unregisterSecond = registerMosaicPlot({
      scope: s,
      name: "hist",
      plot: { interactors: [second] },
    });
    expect(mosaicProducers(s)).toHaveLength(1);
    expect(mosaicProducers(s)[0].source).toBe(second);

    unregisterFirst(); // the disposed predecessor — must be a no-op
    expect(mosaicProducers(s)).toHaveLength(1);
    unregisterSecond();
    expect(mosaicProducers(s)).toHaveLength(0);
  });

  it("scopes the listing: a foreign scope's view excludes it, unscoped belongs everywhere", () => {
    const sel = fakeSelection();
    registerMosaicPlot({ scope: "rx", name: "map", plot: { interactors: [interval2d(sel)] } });
    registerMosaicPlot({ name: "solo", plot: { interactors: [interval1d(sel)] } });
    expect(mosaicProducers("rx").map((e) => e.name)).toEqual(["rx/map", "solo"]);
    expect(mosaicProducers("other").map((e) => e.name)).toEqual(["solo"]);
    expect(mosaicProducers().map((e) => e.name)).toEqual(["rx/map", "solo"]);
  });
});

describe("registerMosaicInput and value()", () => {
  it("defaults fields from the instance, requires a selection, reads published-first values", () => {
    const sel = fakeSelection();
    const menu = { selection: sel, column: "type" };
    registerMosaicInput({ scope: "rx", name: "type-menu", input: menu });
    const entry = mosaicProducers("rx")[0];
    expect(entry).toMatchObject({ name: "rx/type-menu", host: "input", fields: ["type"] });

    // No published clause and no instance value: undefined.
    expect(entry.value()).toBeUndefined();
    // A published clause wins over anything on the instance.
    sel.published.push({ source: menu, value: ["earthquake"] });
    expect(entry.value()).toEqual(["earthquake"]);

    expect(() => registerMosaicInput({ name: "bare", input: {} })).toThrow(/no selection/);
  });

  it("falls back to the instance's own value when nothing is published", () => {
    const sel = fakeSelection();
    const iv = interval1d(sel);
    iv.value = [5, 6];
    registerMosaicPlot({ name: "hist", plot: { interactors: [iv] } });
    expect(mosaicProducers()[0].value()).toEqual([5, 6]);
  });
});
