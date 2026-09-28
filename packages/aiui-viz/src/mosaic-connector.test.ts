/**
 * mosaic-connector.test.ts — the HUGEINT decode over a table that took the
 * real path: encoded to Arrow IPC with the field metadata DuckDB writes,
 * decoded by flechette (what `wasmConnector` does), then converted. What must
 * hold: the marked columns become numbers (signed and unsigned, negatives,
 * nulls), every other column is the SAME object with its metadata intact, a
 * table without such a column comes back as the same object, cells that are
 * not bytes are left alone, and the connector wrapper touches `arrow` results
 * only.
 */
import {
  type Column,
  columnFromArray,
  type Field,
  field,
  fixedSizeBinary,
  float64,
  int32,
  Table,
  tableFromIPC,
  tableToIPC,
} from "@uwdata/flechette";
import type { Connector } from "@uwdata/mosaic-core";
import { describe, expect, it, vi } from "vitest";
import {
  duckdbConnector,
  hugeintToNumber,
  int128ToNumber,
  numericConnector,
} from "./mosaic-connector";

const captured = vi.hoisted(() => ({ options: [] as unknown[] }));
vi.mock("@uwdata/mosaic-core", () => ({
  wasmConnector: (options: unknown) => {
    captured.options.push(options);
    return { query: async (request: { sql: string }) => `stock:${request.sql}` };
  },
}));

/** The 16 little-endian bytes DuckDB writes for a HUGEINT. */
function int128Bytes(value: bigint): Uint8Array {
  const bytes = new Uint8Array(16);
  let v = BigInt.asUintN(128, value);
  for (let i = 0; i < 16; i++) {
    bytes[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return bytes;
}

function opaque(typeName: string): Map<string, string> {
  return new Map([
    ["ARROW:extension:name", "arrow.opaque"],
    ["ARROW:extension:metadata", JSON.stringify({ type_name: typeName, vendor_name: "DuckDB" })],
  ]);
}

/** A table through IPC, as a connector result arrives. */
function roundTrip(entries: Array<[Field, Column]>): Table {
  const table = new Table(
    { fields: entries.map(([f]) => f) },
    entries.map(([, c]) => c),
  );
  return tableFromIPC(tableToIPC(table));
}

describe("int128ToNumber", () => {
  it("reads little-endian two's complement, and unsigned", () => {
    expect(int128ToNumber(int128Bytes(0n), true)).toBe(0);
    expect(int128ToNumber(int128Bytes(2_778_368n), true)).toBe(2_778_368);
    expect(int128ToNumber(int128Bytes(-5n), true)).toBe(-5);
    expect(int128ToNumber(int128Bytes(-5n), false)).toBe(2 ** 128 - 5);
    expect(int128ToNumber(int128Bytes(1n << 64n), true)).toBe(2 ** 64);
  });
});

describe("hugeintToNumber", () => {
  it("converts the marked columns and keeps every other column object and its metadata", () => {
    const x1 = columnFromArray([0, 1, 2], float64());
    const flag = columnFromArray([1, 0, 1], int32());
    const table = roundTrip([
      [field("x1", float64()), x1],
      [
        field("y", fixedSizeBinary(16), true, opaque("hugeint")),
        columnFromArray([int128Bytes(927n), int128Bytes(-47_075n), null], fixedSizeBinary(16)),
      ],
      [
        field("u", fixedSizeBinary(16), true, opaque("uhugeint")),
        columnFromArray(
          [int128Bytes(1n), int128Bytes(1n << 70n), int128Bytes(0n)],
          fixedSizeBinary(16),
        ),
      ],
      [field("flag", int32(), true, new Map([["ARROW:extension:name", "arrow.bool8"]])), flag],
    ]);
    // Sanity: this is what a chart would have received.
    expect(table.getChild("y")?.at(0)).toBeInstanceOf(Uint8Array);

    const out = hugeintToNumber(table);
    expect(out).not.toBe(table);
    // toArray() is a typed array when a column has no nulls, a plain array otherwise.
    expect(Array.from(out.getChild("y")?.toArray() ?? [])).toEqual([927, -47_075, null]);
    expect(Array.from(out.getChild("u")?.toArray() ?? [])).toEqual([1, 2 ** 70, 0]);
    expect(out.schema.fields.map((f) => f.name)).toEqual(["x1", "y", "u", "flag"]);
    expect(out.schema.fields[1]?.type).toEqual(float64());
    expect(out.schema.fields[1]?.metadata?.get("ARROW:extension:name")).toBe("arrow.opaque");
    // Untouched columns are the decoded table's own objects.
    expect(out.getChildAt(0)).toBe(table.getChildAt(0));
    expect(out.getChildAt(3)).toBe(table.getChildAt(3));
    expect(out.schema.fields[3]?.metadata?.get("ARROW:extension:name")).toBe("arrow.bool8");
    expect(out.toArray().map((r) => r.y)).toEqual([927, -47_075, null]);
  });

  it("returns the same table when no column is marked", () => {
    const table = roundTrip([
      [field("n", float64()), columnFromArray([1, 2], float64())],
      [
        field("blob", fixedSizeBinary(16), true, new Map([["ARROW:extension:name", "arrow.uuid"]])),
        columnFromArray([int128Bytes(1n), int128Bytes(2n)], fixedSizeBinary(16)),
      ],
      [
        field("plain", fixedSizeBinary(16)),
        columnFromArray([int128Bytes(3n), int128Bytes(4n)], fixedSizeBinary(16)),
      ],
    ]);
    expect(hugeintToNumber(table)).toBe(table);
  });

  it("leaves a marked column alone when its cells are not bytes (a decoder that knows the type)", () => {
    const already = columnFromArray([4, 5], float64());
    const table = new Table(
      { fields: [field("y", fixedSizeBinary(16), true, opaque("hugeint"))] },
      [already],
    );
    const out = hugeintToNumber(table);
    expect(out.getChildAt(0)).toBe(already);
  });
});

describe("numericConnector", () => {
  it("converts arrow results and delegates exec/json untouched", async () => {
    const decoded = roundTrip([
      [
        field("y", fixedSizeBinary(16), true, opaque("hugeint")),
        columnFromArray([int128Bytes(7n)], fixedSizeBinary(16)),
      ],
    ]);
    const rows = [{ y: new Uint8Array(16) }];
    const requests: unknown[] = [];
    const base = {
      query: async (request: { type?: string; sql: string }) => {
        requests.push(request);
        return request.type === "exec" ? undefined : request.type === "json" ? rows : decoded;
      },
    } as unknown as Connector;
    const connector = numericConnector(base);

    const arrow = await connector.query({ type: "arrow", sql: "SELECT sum(n) AS y" });
    expect(Array.from(arrow.getChild("y")?.toArray() ?? [])).toEqual([7]);
    expect(await connector.query({ sql: "SELECT sum(n) AS y" } as never)).not.toBe(decoded);
    expect(
      await connector.query({ type: "exec", sql: "CREATE TABLE t AS SELECT 1" }),
    ).toBeUndefined();
    expect(await connector.query({ type: "json", sql: "SELECT 1" })).toBe(rows);
    expect(requests).toHaveLength(4);
  });
});

describe("duckdbConnector", () => {
  it("is the stock wasmConnector over the given options, wrapped", async () => {
    const options = { duckdb: {} as never, connection: {} as never };
    const connector = duckdbConnector(options);
    expect(captured.options.at(-1)).toBe(options);
    // A non-table result (the mock's string) passes through the guard-free exec path only;
    // the arrow path expects a table, so exercise exec here.
    expect(await connector.query({ type: "exec", sql: "SELECT 1" })).toBe("stock:SELECT 1");
  });
});
