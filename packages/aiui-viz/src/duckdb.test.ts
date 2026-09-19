import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentToolkit } from "./agent-tools";
import {
  fetchWithProgress,
  formatMarkdown,
  instantiateDuckDB,
  registerSqlTools,
  runSql,
  type SqlResult,
  type SqlRunner,
  schemaOf,
} from "./duckdb";

// instantiateDuckDB's collaborators, captured through a module mock: the
// selected bundle is fixed, AsyncDuckDB records the worker it was handed and
// every instantiate() call's arguments.
const captured = vi.hoisted(() => ({
  instantiateArgs: [] as unknown[][],
  workers: [] as unknown[],
}));
vi.mock("@duckdb/duckdb-wasm", () => ({
  selectBundle: async () => ({
    mainWorker: "assets/w.js",
    mainModule: "assets/m.wasm",
    pthreadWorker: null,
  }),
  VoidLogger: class {},
  AsyncDuckDB: class {
    worker: unknown;
    constructor(_logger: unknown, worker: unknown) {
      this.worker = worker;
      captured.workers.push(worker);
    }
    async instantiate(...args: unknown[]): Promise<void> {
      captured.instantiateArgs.push(args);
    }
  },
}));

/** A streamed Response of `chunks` with an optional Content-Length header. */
function streamed(chunks: Uint8Array[], contentLength?: number): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
  const headers =
    contentLength !== undefined ? { "content-length": String(contentLength) } : undefined;
  return new Response(body, { status: 200, ...(headers ? { headers } : {}) });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchWithProgress", () => {
  it("concatenates streamed chunks and reports monotone fractions ending at 1", async () => {
    const chunks = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => streamed(chunks, 5)),
    );
    const fractions: number[] = [];
    const out = await fetchWithProgress("http://x/data.parquet", (f) => fractions.push(f));
    expect([...out]).toEqual([1, 2, 3, 4, 5]);
    expect(fractions.at(-1)).toBe(1);
    for (let i = 1; i < fractions.length; i++) {
      expect(fractions[i]).toBeGreaterThanOrEqual(fractions[i - 1]);
    }
    // Mid-stream reports never claim completion (capped below 1 until done).
    expect(fractions.slice(0, -1).every((f) => f < 1)).toBe(true);
  });

  it("still resolves (progress jumps to 1) when the length is unknown", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => streamed([new Uint8Array([9, 9])])),
    );
    const fractions: number[] = [];
    const out = await fetchWithProgress("http://x/d", (f) => fractions.push(f));
    expect(out.length).toBe(2);
    expect(fractions).toEqual([1]);
  });

  it("throws with the status on a non-OK response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 404, statusText: "Not Found" })),
    );
    await expect(fetchWithProgress("http://x/missing", () => {})).rejects.toThrow(/404/);
  });
});

// A minimal bundles value — selection is mocked, so the content is inert.
const BUNDLES = { eh: { mainModule: "x", mainWorker: "y" } } as Parameters<
  typeof instantiateDuckDB
>[0];

describe("instantiateDuckDB", () => {
  afterEach(() => {
    captured.instantiateArgs.length = 0;
    captured.workers.length = 0;
  });

  it("hands the selected bundle's worker URL to workerFactory and adopts its Worker", async () => {
    const worker = { theInstrumentedOne: true };
    const factory = vi.fn(() => worker as unknown as Worker);
    await instantiateDuckDB(BUNDLES, { workerFactory: factory });
    expect(factory).toHaveBeenCalledWith("assets/w.js");
    expect(captured.workers).toEqual([worker]);
  });

  it("defaults to new Worker(url) when no factory is given", async () => {
    class FakeWorker {
      constructor(public url: string) {}
    }
    vi.stubGlobal("Worker", FakeWorker);
    await instantiateDuckDB(BUNDLES);
    expect(captured.workers).toHaveLength(1);
    expect((captured.workers[0] as FakeWorker).url).toBe("assets/w.js");
  });

  it("absolutizes module URLs for instantiate — a blob:-bootstrapped worker has no base", async () => {
    await instantiateDuckDB(BUNDLES, { workerFactory: () => ({}) as Worker });
    const [mainModule, pthreadWorker] = captured.instantiateArgs[0];
    expect(mainModule).toBe(new URL("assets/m.wasm", location.href).href);
    expect(pthreadWorker).toBeNull();
  });
});

// ── the agent's SQL tools ─────────────────────────────────────────────────────

/** A scripted runner: answers from a table of SQL-pattern → result, records
 * every statement it saw, and can be made slow or cancellable. */
function fakeRunner(
  answers: Array<[RegExp, SqlResult | (() => SqlResult)]>,
  options: { delayMs?: number } = {},
) {
  const seen: string[] = [];
  let cancelled = 0;
  const runner: SqlRunner = {
    async query(sql) {
      seen.push(sql);
      if (options.delayMs !== undefined) {
        await new Promise((r) => setTimeout(r, options.delayMs));
      }
      const hit = answers.find(([pattern]) => pattern.test(sql));
      if (!hit) throw new Error(`Parser Error: syntax error at or near "${sql.slice(0, 12)}"`);
      return typeof hit[1] === "function" ? hit[1]() : hit[1];
    },
    async cancel() {
      cancelled += 1;
    },
  };
  return { runner, seen, cancelled: () => cancelled };
}

const ROWS = (n: number): SqlResult => ({
  columns: ["id", "name"],
  types: ["BIGINT", "VARCHAR"],
  rows: Array.from({ length: n }, (_, i) => [BigInt(i), `row ${i}`]),
});

describe("runSql — the guards every consumer relies on", () => {
  it("wraps the statement in a LIMIT one past the cap and reports truncation exactly", async () => {
    const { runner, seen } = fakeRunner([[/_q LIMIT 3$/, ROWS(3)]]);
    const out = await runSql(runner, "SELECT id, name FROM t ;", { limit: 2 });
    expect(seen[0]).toBe("SELECT * FROM (SELECT id, name FROM t) AS _q LIMIT 3");
    expect(out.rows).toEqual([
      [0, "row 0"],
      [1, "row 1"],
    ]); // BigInt → number, and only `limit` rows
    expect(out.types).toEqual(["BIGINT", "VARCHAR"]);
    expect(out.truncated).toEqual({ rows: true, bytes: false, limit: 2, byteCap: 32768 });
  });

  it("is not truncated when the query had fewer rows than the limit", async () => {
    const { runner } = fakeRunner([[/LIMIT 201$/, ROWS(5)]]);
    const out = await runSql(runner, "with q as (select 1) select * from q");
    expect(out.rows).toHaveLength(5);
    expect(out.truncated.rows).toBe(false);
  });

  it("refuses anything but one SELECT/WITH statement — before touching the database", async () => {
    const { runner, seen } = fakeRunner([]);
    await expect(runSql(runner, "DROP TABLE t")).rejects.toThrow(/only read-only SELECT\/WITH/);
    await expect(runSql(runner, "SELECT 1; SELECT 2")).rejects.toThrow(/one statement at a time/);
    expect(seen).toEqual([]);
  });

  it("stops at the byte budget and says so; cells are bounded and JSON-safe", async () => {
    const wide: SqlResult = {
      columns: ["t", "when", "blob", "big", "nested"],
      rows: [
        [
          "x".repeat(1000),
          new Date("2026-09-19T00:00:00Z"),
          new Uint8Array(3),
          2n ** 60n,
          { a: 1n },
        ],
        ["y", null, null, 1n, null],
        ["z", null, null, 1n, null],
      ],
    };
    const { runner } = fakeRunner([[/./, wide]]);
    const out = await runSql(runner, "select *", { byteCap: 300 });
    const [first] = out.rows;
    expect(String(first?.[0])).toHaveLength(257); // 256 + the marker
    expect(first?.[1]).toBe("2026-09-19T00:00:00.000Z");
    expect(first?.[2]).toBe("<3 bytes>");
    expect(first?.[3]).toBe((2n ** 60n).toString()); // past safe-integer → string
    expect(first?.[4]).toEqual({ a: 1 });
    expect(out.rows).toHaveLength(1); // the second row would cross the budget
    expect(out.truncated).toMatchObject({ rows: true, bytes: true });
  });

  it("forwards DuckDB's error message untouched — the model fixes and retries", async () => {
    const { runner } = fakeRunner([]);
    await expect(runSql(runner, "SELECT nope FROM t")).rejects.toThrow(
      /Parser Error: syntax error/,
    );
  });

  it("times out, cancels the statement, and names the timeout", async () => {
    const { runner, cancelled } = fakeRunner([[/./, ROWS(1)]], { delayMs: 50 });
    await expect(runSql(runner, "select 1", { timeoutMs: 5 })).rejects.toThrow(
      /timed out after 5 ms/,
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(cancelled()).toBe(1);
  });

  it("says the database is not loaded yet while the runner promise is pending", async () => {
    const pending = new Promise<SqlRunner>(() => {});
    await expect(runSql(pending, "select 1", { timeoutMs: 5 })).rejects.toThrow(/not loaded yet/);
  });
});

describe("formatMarkdown", () => {
  it("renders a table with a row-count footer that names the truncation", async () => {
    const { runner } = fakeRunner([
      [
        /./,
        {
          columns: ["a", "b"],
          rows: [
            [1, "x|y"],
            [2, null],
          ],
        },
      ],
    ]);
    const out = await runSql(runner, "select 1");
    expect(formatMarkdown(out)).toBe(
      ["| a | b |", "| --- | --- |", "| 1 | x\\|y |", "| 2 |  |", "(2 rows)"].join("\n"),
    );
    const cut = await runSql(runner, "select 1", { limit: 1 });
    expect(formatMarkdown(cut)).toContain("(1 rows shown; truncated at limit 1)");
  });
});

describe("schemaOf", () => {
  const catalog = fakeRunner([
    [
      /information_schema\.tables/,
      {
        columns: ["table_name", "table_type"],
        rows: [
          ["quakes", "BASE TABLE"],
          ["world", "VIEW"],
        ],
      },
    ],
    [
      /information_schema\.columns/,
      {
        columns: ["table_name", "column_name", "data_type"],
        rows: [
          ["quakes", "mag", "DOUBLE"],
          ["quakes", "time", "TIMESTAMP"],
          ["world", "lon", "DOUBLE"],
        ],
      },
    ],
    [/SUMMARIZE "quakes"/, { columns: ["column_name", "min"], rows: [["mag", 0.1]] }],
  ]);

  it("groups columns by table, minus the system schemas", async () => {
    const schema = await schemaOf(catalog.runner);
    expect(schema.tables).toEqual([
      {
        name: "quakes",
        type: "BASE TABLE",
        columns: [
          { name: "mag", type: "DOUBLE" },
          { name: "time", type: "TIMESTAMP" },
        ],
      },
      { name: "world", type: "VIEW", columns: [{ name: "lon", type: "DOUBLE" }] },
    ]);
    expect(catalog.seen[0]).toContain("table_schema NOT IN ('information_schema', 'pg_catalog')");
    expect(schema.summary).toBeUndefined();
  });

  it("narrows to one table (quoted) and adds SUMMARIZE only on request", async () => {
    const schema = await schemaOf(catalog.runner, { table: "quakes", summarize: true });
    expect(catalog.seen.some((s) => s.includes("table_name = 'quakes'"))).toBe(true);
    expect(schema.summary?.rows).toEqual([["mag", 0.1]]);
  });
});

describe("registerSqlTools", () => {
  function fakeKit() {
    const tools = new Map<string, Parameters<AgentToolkit["registerTool"]>[0]>();
    const kit = {
      ns: "test",
      registerTool: (tool: Parameters<AgentToolkit["registerTool"]>[0]) =>
        void tools.set(tool.name, tool),
    } as unknown as AgentToolkit;
    return { kit, tools };
  }

  it("registers sql + schema as reads with usage, and names the tables once introspected", async () => {
    const { runner } = fakeRunner([
      [
        /information_schema\.tables/,
        { columns: ["table_name", "table_type"], rows: [["quakes", "BASE TABLE"]] },
      ],
      [
        /information_schema\.columns/,
        { columns: ["table_name", "column_name", "data_type"], rows: [] },
      ],
      [/from t\)/i, ROWS(1)],
    ]);
    let resolve!: (r: SqlRunner) => void;
    const later = new Promise<SqlRunner>((r) => {
      resolve = r;
    });
    const { kit, tools } = fakeKit();
    registerSqlTools(kit, { runner: later, defaultLimit: 50 });
    expect(tools.get("sql")).toMatchObject({ kind: "read" });
    expect(tools.get("schema")).toMatchObject({ kind: "read" });
    expect(tools.get("sql")?.usage).toContain("Call schema first"); // nothing known yet
    expect(tools.get("sql")?.usage).toContain("capped at 50 rows");

    resolve(runner);
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(tools.get("sql")?.usage).toContain("Tables: `quakes`"); // re-registered with the list

    const out = (await tools.get("sql")?.run({ sql: "select * from t", limit: 1 })) as {
      rows: unknown[][];
    };
    expect(out.rows).toEqual([[0, "row 0"]]);
    const md = (await tools.get("sql")?.run({ sql: "select * from t", format: "markdown" })) as {
      markdown: string;
    };
    expect(md.markdown).toContain("| id | name |");
  });

  it("takes an explicit table list instead of introspecting", () => {
    const { kit, tools } = fakeKit();
    registerSqlTools(kit, { runner: fakeRunner([]).runner, tables: ["wine", "province_geo"] });
    expect(tools.get("sql")?.usage).toContain("Tables: `wine`, `province_geo`");
  });
});
