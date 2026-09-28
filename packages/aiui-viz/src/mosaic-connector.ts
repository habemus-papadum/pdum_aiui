/**
 * mosaic-connector.ts — the Mosaic connector every aiui DuckDB app should
 * install: Mosaic's stock `wasmConnector`, plus DuckDB's 128-bit integers
 * decoded to numbers.
 *
 * The fact this module exists for (measured 2026-09-28, duckdb-wasm
 * 1.33.1-dev64.0 — the stock build and the one `@motherduck/wasm-client`
 * vendors, byte-identical): **DuckDB exports HUGEINT and UHUGEINT to Arrow as
 * an `arrow.opaque` extension over 16 raw bytes**, whatever
 * `arrow_lossless_conversion` says (it is a GLOBAL setting, and SET/RESET
 * changes nothing about the export). Older DuckDBs used the `duckdb.hugeint`
 * extension name for the same layout. Flechette — Mosaic's Arrow decoder —
 * knows neither name and hands back a `Uint8Array` per cell; apache-arrow does
 * the same. And `sum()` over ANY integer column is HUGEINT in DuckDB, which is
 * exactly what Mosaic's pre-aggregation issues on every brush: the cube stores
 * `count(*)` per bin, the brush query is `coalesce(sum(count), 0)`. So a
 * brushed histogram's `y` arrives as bytes, vgplot coerces it to NaN, the axis
 * prints "NaN" and every bar goes full height — while the unbrushed render,
 * a programmatic `selectionDim` set (no scale metadata, so no cube) and every
 * `count(*)` stay fine, which is what made this look like a website bug.
 *
 * What {@link hugeintToNumber} does: after the IPC decode, find the fields
 * carrying that extension marker and replace ONLY those columns with float64
 * columns, leaving every other column object and the schema's metadata
 * untouched. It never rewrites SQL, never adds a query, never changes what
 * comes down from a remote engine; it runs on the decoded result in the tab,
 * and a result without such a column is returned as the very same object
 * after one scan of the field list (microseconds). Precision: a JavaScript
 * number holds 53 bits, the same loss flechette already applies to every
 * BIGINT by default and the loss DuckDB's old DOUBLE export had. `json`
 * results are left alone: rows carry no schema, and a 16-byte cell could as
 * well be a UUID.
 *
 * The condition is exact (extension name + DuckDB's own `type_name`), so the
 * shim retires itself: if DuckDB goes back to a numeric export the marker is
 * gone; if flechette learns the type the cells are no longer bytes and the
 * guard leaves them be.
 *
 * Lives on its own subpath (`@habemus-papadum/aiui-viz/mosaic-connector`)
 * because it imports `@uwdata/mosaic-core` and `@uwdata/flechette` at
 * runtime — optional peers only Mosaic consumers install.
 */
import {
  type Column,
  columnFromArray,
  type Field,
  field,
  float64,
  Table,
  Type,
} from "@uwdata/flechette";
import {
  type ArrowQueryRequest,
  type Connector,
  type ConnectorQueryRequest,
  type ExecQueryRequest,
  type JSONQueryRequest,
  wasmConnector,
} from "@uwdata/mosaic-core";

/** Which 128-bit integer a field carries, or undefined for any other field. */
function int128Kind(f: Field): "signed" | "unsigned" | undefined {
  if (f.type.typeId !== Type.FixedSizeBinary) return;
  if ((f.type as { stride?: number }).stride !== 16) return;
  const meta = f.metadata;
  if (!(meta instanceof Map)) return;
  const name = meta.get("ARROW:extension:name");
  if (name === "duckdb.hugeint") return "signed";
  if (name === "duckdb.uhugeint") return "unsigned";
  if (name !== "arrow.opaque") return;
  let typeName: unknown;
  try {
    typeName = JSON.parse(meta.get("ARROW:extension:metadata") ?? "{}")?.type_name;
  } catch {
    return;
  }
  return typeName === "hugeint" ? "signed" : typeName === "uhugeint" ? "unsigned" : undefined;
}

/** A little-endian 128-bit two's-complement (or unsigned) integer as a number. */
export function int128ToNumber(bytes: Uint8Array, signed: boolean): number {
  let v = 0n;
  for (let i = 15; i >= 0; i--) v = (v << 8n) | BigInt(bytes[i] ?? 0);
  return Number(signed ? BigInt.asIntN(128, v) : v);
}

/**
 * The decoded result with every DuckDB HUGEINT/UHUGEINT column (the
 * `arrow.opaque` / `duckdb.hugeint` extension over 16 bytes) replaced by a
 * float64 column. A table without one is returned as the same object. Cells
 * that are not byte arrays (a decoder that already understands the type) are
 * left as they are.
 */
export function hugeintToNumber(table: Table): Table {
  const fields = table.schema.fields;
  if (!fields.some(int128Kind)) return table;
  const nextFields: Field[] = [];
  const nextColumns: Column<unknown>[] = [];
  fields.forEach((f, i) => {
    const kind = int128Kind(f);
    const column = table.getChildAt(i) as Column<unknown>;
    const values: unknown[] = kind ? Array.from(column.toArray()) : [];
    if (!kind || !values.some((v) => v instanceof Uint8Array)) {
      nextFields.push(f);
      nextColumns.push(column);
      return;
    }
    const numbers = values.map((v) =>
      v instanceof Uint8Array ? int128ToNumber(v, kind === "signed") : (v as number | null),
    );
    nextFields.push(field(f.name, float64(), f.nullable, f.metadata));
    nextColumns.push(columnFromArray(numbers, float64()));
  });
  return new Table({ ...table.schema, fields: nextFields }, nextColumns);
}

/**
 * Wrap any Mosaic connector so its `arrow` results pass through
 * {@link hugeintToNumber}. `exec` and `json` requests are delegated as they
 * are. Compose it at the app's data-layer root, outermost: a credential
 * installer or a SQL-rewriting connector underneath still sees plain requests.
 */
export function numericConnector(base: Connector): Connector {
  async function query(request: ArrowQueryRequest): Promise<Table>;
  async function query(request: ExecQueryRequest): Promise<void>;
  async function query(request: JSONQueryRequest): Promise<Record<string, unknown>[]>;
  async function query(request: ConnectorQueryRequest): Promise<unknown> {
    const result = await base.query(request as ArrowQueryRequest);
    return request.type === "exec" || request.type === "json" ? result : hugeintToNumber(result);
  }
  return { query };
}

/** What Mosaic's `wasmConnector` takes: a pre-built `AsyncDuckDB` and/or one of its connections. */
export type DuckdbConnectorOptions = Parameters<typeof wasmConnector>[0];

/**
 * Mosaic's stock `wasmConnector` over the app's DuckDB-WASM instance, with
 * 128-bit integers decoded to numbers. The one call to make where an app
 * would otherwise write `wasmConnector({ duckdb, connection })`:
 *
 * ```ts
 * coordinator.databaseConnector(duckdbConnector({ duckdb: db, connection: await db.connect() }));
 * ```
 */
export function duckdbConnector(options: DuckdbConnectorOptions = {}): Connector {
  return numericConnector(wasmConnector(options));
}
