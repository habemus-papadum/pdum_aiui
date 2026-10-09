// @vitest-environment jsdom
/**
 * crossfilter: clause routing over the real pinned mosaic-core Selection —
 * a clause reaches a client only when its table can bind the columns; the
 * stock self-exclusion still applies; unknown tables are permissive until
 * described; retractions route like the clause they retract; per-table
 * predicates for the schema views.
 */
import { clauseInterval, clausePoints, Selection } from "@uwdata/mosaic-core";
import { and, column } from "@uwdata/mosaic-sql";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentToolkit } from "./agent-tools";
import { actionByName, clearControlSurface } from "./control";
import {
  clientTable,
  crossfilter,
  crossfilterClausesFor,
  crossfilterPredicateSql,
  type crossfilterReport,
  crossfilterRouting,
  crossfilterViews,
  learnColumns,
  registerCrossfilterTools,
  selectionDimSchema,
} from "./crossfilter";
import { disposeDurable } from "./durable";
import { clearMosaicProducerRegistry, registerMosaicInput } from "./mosaic-registry";
import { clearSelectionDimRegistry, selectionDim } from "./mosaic-selection";
import { scope } from "./scope";
import { tick } from "./testing";

afterEach(() => {
  clearMosaicProducerRegistry();
  disposeDurable("mosaic-producers:registry");
  for (const key of clearSelectionDimRegistry().durableKeys) disposeDurable(key);
  for (const key of clearControlSurface().durableKeys) disposeDurable(key);
});

const mark = (table: string) => ({ sourceTable: () => table }) as never;
const sqlOf = (p: unknown): string[] =>
  p === undefined || p === null ? [] : (Array.isArray(p) ? p : [p]).map(String);

describe("clientTable", () => {
  it("reads a mark's sourceTable(), an input's from, or a declared table", () => {
    expect(clientTable({ sourceTable: () => "quakes" })).toBe("quakes");
    expect(clientTable({ sourceTable: () => null })).toBeUndefined();
    expect(clientTable({ from: "sessions" })).toBe("sessions");
    expect(clientTable({ table: "t" })).toBe("t");
    expect(clientTable({ source: { table: "u" } })).toBe("u");
    expect(clientTable({})).toBeUndefined();
    expect(clientTable(null)).toBeUndefined();
  });
});

describe("crossfilter routing", () => {
  it("routes a clause only to clients whose table has its columns; a 2-D clause needs both", () => {
    const sel = crossfilter({
      columns: { quakes: ["mag", "year", "lon", "lat"], sessions: ["year", "lon"] },
    });
    const mag = { name: "mag-src" };
    const box = { name: "box-src" };
    sel.update(clauseInterval(column("mag"), [5, 6], { source: mag }));
    sel.update(clauseInterval(column("year"), [2000, 2010], { source: { name: "year-src" } }));
    // A 2-D box names lon AND lat (the shape mosaic-plot's Interval2D publishes).
    sel.update({
      source: box,
      value: null,
      predicate: and(
        clauseInterval(column("lon"), [0, 1], { source: box }).predicate,
        clauseInterval(column("lat"), [0, 1], { source: box }).predicate,
      ),
    } as never);

    expect(sqlOf(sel.predicate(mark("quakes")))).toHaveLength(3);
    const forSessions = sqlOf(sel.predicate(mark("sessions")));
    expect(forSessions).toHaveLength(1);
    expect(forSessions[0]).toContain("year");
    // a client naming no table gets everything, as before
    expect(sqlOf(sel.predicate({} as never))).toHaveLength(3);
    // and the aggregate (no client) is every clause
    expect(sqlOf(sel.predicate())).toHaveLength(3);
  });

  it("keeps Mosaic's self-exclusion", () => {
    const sel = crossfilter({ columns: { quakes: ["mag"] } });
    const me = mark("quakes");
    sel.update(clauseInterval(column("mag"), [5, 6], { source: {}, clients: new Set([me]) }));
    expect(sel.predicate(me)).toBeUndefined(); // the active clause is mine: skipped whole
    expect(sqlOf(sel.predicate(mark("quakes")))).toHaveLength(1);
  });

  it("is permissive for an unknown table, then learns it — eagerly from describe", async () => {
    const asked: string[] = [];
    const sel = crossfilter({
      describe: async (table) => {
        asked.push(table);
        return ["year"];
      },
    });
    sel.update(clauseInterval(column("mag"), [5, 6], { source: {} }));
    expect(sqlOf(sel.predicate(mark("sessions")))).toHaveLength(1); // not known yet
    await new Promise((r) => setTimeout(r, 0));
    expect(asked).toEqual(["sessions"]);
    expect(sqlOf(sel.predicate(mark("sessions")))).toHaveLength(0); // now routed away
    expect(crossfilterRouting(sel)?.tables()).toEqual(["sessions"]);
    expect(crossfilterRouting(sel)?.columnsOf("sessions")).toEqual(["year"]);
  });

  it("routes a retraction like the clause it retracts, and honours exclude", () => {
    const sel = crossfilter({
      columns: { a: ["year"], b: ["year"] },
      exclude: { b: ["year"] }, // b's `year` means something else
    });
    const src = { name: "year-src" };
    const live = clauseInterval(column("year"), [2000, 2010], { source: src });
    sel.update(live);
    expect(sqlOf(sel.predicate(mark("a")))).toHaveLength(1);
    expect(sqlOf(sel.predicate(mark("b")))).toHaveLength(0);
    const gone = clauseInterval(column("year"), null, { source: src });
    expect(crossfilterRouting(sel)?.routes(gone, "a")).toBe(true);
    expect(crossfilterRouting(sel)?.routes(gone, "b")).toBe(false);
  });

  it("gives one table's resolved WHERE and the split of applying vs dropped clauses", () => {
    const sel = crossfilter({ columns: { quakes: ["mag", "type"], sessions: ["type"] } });
    sel.update(clauseInterval(column("mag"), [5, 6], { source: {} }));
    sel.update(clausePoints([column("type")], [["eq"]], { source: {} }));
    expect(crossfilterPredicateSql(sel, "quakes")).toMatch(/mag.*AND.*type|type.*AND.*mag/);
    expect(crossfilterPredicateSql(sel, "sessions")).toMatch(/^.*type.*$/);
    expect(crossfilterPredicateSql(sel, "sessions")).not.toContain("mag");
    // an unknown table is permissive: it gets everything, as before routing
    expect(crossfilterPredicateSql(sel, "nothing")).toContain("mag");
    const split = crossfilterClausesFor(sel, "sessions");
    expect(split.applies).toHaveLength(1);
    expect(split.dropped).toHaveLength(1);
    expect(split.dropped[0]).toContain("mag");
    // a stock Selection routes everything
    const stock = Selection.crossfilter();
    stock.update(clauseInterval(column("mag"), [5, 6], { source: {} }));
    expect(crossfilterPredicateSql(stock, "sessions")).toContain("mag");
    expect(crossfilterRouting(stock)).toBeUndefined();
  });

  it("warns when a declared dimension's column is missing from its table, on learn", () => {
    const warnings: string[] = [];
    const orig = console.warn;
    console.warn = (m: unknown) => warnings.push(String(m));
    try {
      const sel = crossfilter();
      selectionDim({
        name: "magnitude",
        kind: "interval",
        targets: [{ selection: sel, field: "magnitud", table: "quakes" }],
      });
      learnColumns(sel, "quakes", ["mag", "year"]);
      expect(warnings.join("\n")).toMatch(
        /"magnitude" filters quakes\.magnitud, but quakes has no column/,
      );
      learnColumns({}, "quakes", ["mag"]); // a stock Selection: no-op
    } finally {
      console.warn = orig;
    }
  });
});

describe("crossfilterViews — the schema-view provider", () => {
  const base = [
    {
      name: "quakes",
      schema: "main",
      type: "BASE TABLE",
      columns: [
        { name: "mag", type: "DOUBLE" },
        { name: "year", type: "INTEGER" },
      ],
    },
    {
      name: "sessions",
      schema: "main",
      type: "BASE TABLE",
      columns: [{ name: "year", type: "INTEGER" }],
    },
    {
      name: "notes",
      schema: "main",
      type: "BASE TABLE",
      columns: [{ name: "text", type: "VARCHAR" }],
    },
  ];

  it("offers a view per covered table, teaches the router the columns, and describes what applies", () => {
    const s = scope("cfv");
    const sel = crossfilter();
    selectionDim({
      name: "mag",
      scope: s,
      kind: "interval",
      targets: [{ selection: sel, field: "mag", table: "quakes" }],
    });
    const provider = crossfilterViews({ selection: sel, scope: s, tables: ["sessions"] });
    expect(provider.id).toBe("cross-filter");
    const views = provider.views(base);
    expect(views.map((v) => `${v.schema}.${v.name}`)).toEqual([
      "crossfilter.quakes",
      "crossfilter.sessions",
    ]);
    expect(crossfilterRouting(sel)?.columnsOf("notes")).toEqual(["text"]); // learned, though not covered
    sel.update(clauseInterval(column("mag"), [7, 9], { source: { name: "src" } }));
    // Schema-qualified: a bare name inside the view would bind to the view itself.
    expect(views[0]?.sql()).toBe('SELECT * FROM "main"."quakes" WHERE ("mag" BETWEEN 7 AND 9)');
    expect(views[1]?.sql()).toBe('SELECT * FROM "main"."sessions" WHERE TRUE');
    expect(views[0]?.describe()).toMatchObject({ provider: "cross-filter", clauses: 1 });
    expect(views[1]?.describe()).toMatchObject({
      clauses: 0,
      notApplied: ['("mag" BETWEEN 7 AND 9)'],
    });
    // the subscription is the Selection's value event
    let fired = 0;
    const off = provider.subscribe?.(() => fired++);
    sel.update(clauseInterval(column("mag"), [8, 9], { source: { name: "src2" } }));
    expect(fired).toBeGreaterThan(0);
    off?.();
  });
});

describe("registerCrossfilterTools", () => {
  function fakeKit() {
    const reporters = new Map<string, () => unknown>();
    const kit = {
      ns: "cft",
      registerTool: () => {},
      registerReporter: (name: string, fn: () => unknown) => void reporters.set(name, fn),
    } as unknown as AgentToolkit;
    return { kit, reporters };
  }

  it("registers one cross-filter tool whose schema follows the dimensions, sets several at once, clears by name, and reports the predicate", async () => {
    const s = scope("cft");
    const sel = crossfilter({ columns: { quakes: ["mag", "year", "type"] } });
    const { kit, reporters } = fakeKit();
    const off = registerCrossfilterTools(kit, { scope: s, selection: sel });
    const mag = selectionDim({
      name: "mag",
      scope: s,
      kind: "interval",
      min: 0,
      max: 10,
      targets: [{ selection: sel, field: "mag", table: "quakes" }],
    });
    selectionDim({
      name: "type",
      scope: s,
      kind: "point",
      options: ["eq", "nuke"],
      targets: [{ selection: sel, field: "type", table: "quakes" }],
    });

    const tool = actionByName("cft/cross-filter");
    expect(tool).toBeDefined();
    const schema = tool?.inputSchema as {
      properties: { set: { properties: Record<string, Record<string, unknown>> } };
    };
    expect(Object.keys(schema.properties.set.properties)).toEqual(["mag", "type"]);
    expect(schema.properties.set.properties.mag).toMatchObject({
      type: "object",
      properties: { lo: { minimum: 0, maximum: 10 } },
    });
    expect(schema.properties.set.properties.type).toMatchObject({
      type: "array",
      items: { enum: ["eq", "nuke"] },
    });
    expect(tool?.usage).toContain("mag (interval 0–10)");

    const out = (await tool?.run?.({
      set: { mag: { lo: 12 }, type: ["nuke"], nope: [1] },
    })) as Record<string, unknown>;
    expect(out).toMatchObject({
      applied: { mag: { lo: 10 }, type: ["nuke"] }, // clamped, checked
      cleared: [],
      errors: { nope: expect.stringMatching(/no dimension "nope"/) },
      views: ["crossfilter.quakes"],
    });
    expect(String(out.predicate)).toMatch(/mag.*type|type.*mag/);
    expect(sel.clauses).toHaveLength(2); // the result waited for the task boundary

    expect(await tool?.run?.({ clear: ["mag"] })).toMatchObject({
      cleared: ["cft/mag"],
      applied: {},
    });
    expect(await tool?.run?.({ set: { type: null } })).toMatchObject({ applied: { type: null } });
    expect(sel.clauses).toHaveLength(0);
    await expect(tool?.run?.({})).rejects.toThrow(/pass set/);
    // a per-name error, not a failure
    const bad = (await tool?.run?.({ set: { mag: { lo: 9, hi: 1 } } })) as {
      errors: Record<string, string>;
    };
    expect(bad.errors.mag).toMatch(/must be ≤/);

    // reset: every clause and every dimension value, visuals through reset()
    mag.set({ lo: 5 });
    await tick();
    const reset = actionByName("cft/reset-cross-filters");
    expect(await reset?.run?.({})).toMatchObject({
      reset: true,
      activeClauses: 0,
      predicate: "TRUE",
    });
    expect(mag.get()).toBeNull();

    // the report section: predicate, per-table WHERE, views, dimensions, attributed clauses
    mag.set({ hi: 6 });
    await tick();
    registerMosaicInput({
      scope: s,
      name: "menu",
      input: { selection: sel, field: "type", from: "quakes" },
    });
    const report = (reporters.get("crossfilter") as () => ReturnType<typeof crossfilterReport>)();
    expect(report.predicate).toContain("mag");
    expect(report.tables).toEqual({ quakes: report.predicate });
    expect(report.views).toEqual(["crossfilter.quakes"]);
    expect(report.dimensions).toEqual({ "cft/mag": { hi: 6 }, "cft/type": null });
    expect(report.active).toEqual([
      expect.objectContaining({ origin: "dim", producer: "cft/mag" }),
    ]);
    expect(
      report.capabilities.some((c) =>
        c.producers.some((p) => p.name === "cft/menu" && p.tables[0] === "quakes"),
      ),
    ).toBe(true);
    off();
  });

  it("selectionDimSchema renders the two kinds", () => {
    expect(
      selectionDimSchema({
        name: "d",
        kind: "interval",
        value: null,
        targets: [],
        min: 0,
        unit: "km",
        description: "Depth",
      }),
    ).toEqual({
      type: "object",
      description: "Depth (km) — lo and/or hi, inclusive; one side alone is open-ended",
      properties: {
        lo: { type: "number", description: "inclusive lower bound", minimum: 0 },
        hi: { type: "number", description: "inclusive upper bound", minimum: 0 },
      },
      additionalProperties: false,
    });
    expect(selectionDimSchema({ name: "t", kind: "point", value: null, targets: [] })).toEqual({
      type: "array",
      description: "t — rows matching ANY of the values pass",
      items: {},
    });
  });
});
