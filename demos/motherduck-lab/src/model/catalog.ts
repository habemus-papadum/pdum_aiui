/**
 * catalog.ts — the lab's pure model (playbook layer 1): how a table in the
 * MotherDuck-attached engine is named, which tables and columns the lab
 * offers, and the SQL of the two things it does — pull a slice of a cloud
 * table into the tab, and ask a hybrid question that spans both sides.
 *
 * Names are the whole subtlety. The engine holds several catalogs at once —
 * the tab's own `memory`, the attached MotherDuck databases and shares,
 * `md_information_schema` — so a table is a triple, and Mosaic must see it as
 * one. Measured 2026-09-24, vgplot 0.28.1: `from("db.main.t")` quotes ONE
 * identifier, and `from(["db", "main", "t"])` is worse — the mark spreads the
 * array into THREE tables and cross-joins them (`FROM "db", "main", "t"`).
 * The bridge that works is the one the duckdb-mosaic doc prescribes for any
 * attached catalog: a local VIEW in the tab's `memory` catalog over the
 * qualified name ({@link createViewSql}), and Mosaic reads the plain view
 * name. It copies nothing; dual execution still runs the scan remotely.
 */

export interface TableRef {
  catalog: string;
  schema: string;
  table: string;
}

/** Catalogs the lab never offers as data. */
export const SYSTEM_CATALOGS: ReadonlySet<string> = new Set([
  "system",
  "temp",
  "md_information_schema",
]);
/** Schemas the lab never offers as data (Mosaic's own cube schema included). */
export const SYSTEM_SCHEMAS: ReadonlySet<string> = new Set([
  "information_schema",
  "pg_catalog",
  "mosaic",
]);

/** The local table the lab materializes into — in the tab's `memory` catalog. */
export const LOCAL_SAMPLE = "local_sample";

/** One `information_schema.tables` row, as the lab reads it. */
export interface TableRow {
  table_catalog: string;
  table_schema: string;
  table_name: string;
  table_type: string;
}

/** Offer a row as data: not a system catalog or schema, not the lab's own sample. */
export function isUserTable(row: TableRow): boolean {
  return (
    !SYSTEM_CATALOGS.has(row.table_catalog) &&
    !SYSTEM_SCHEMAS.has(row.table_schema) &&
    !(row.table_catalog === "memory" && row.table_name === LOCAL_SAMPLE)
  );
}

export function tableRefOf(row: TableRow): TableRef {
  return { catalog: row.table_catalog, schema: row.table_schema, table: row.table_name };
}

/** The dotted display form — and the durable/URL key. */
export function tableRefKey(ref: TableRef): string {
  return `${ref.catalog}.${ref.schema}.${ref.table}`;
}

/** Parse a key back; undefined for anything but three non-empty parts. */
export function parseTableRefKey(key: string): TableRef | undefined {
  const parts = key.split(".");
  if (parts.length !== 3 || parts.some((p) => p === "")) return undefined;
  const [catalog, schema, table] = parts as [string, string, string];
  return { catalog, schema, table };
}

/** The triple as an array — mosaic-sql's `from()` qualifies it, vgplot's marks do NOT (see the module doc). */
export function qualifiedRef(ref: TableRef): [string, string, string] {
  return [ref.catalog, ref.schema, ref.table];
}

/** The local view's name for a ref: what Mosaic's marks read. */
export function viewNameFor(ref: TableRef): string {
  return `${ref.catalog}__${ref.schema}__${ref.table}`.replaceAll(/[^A-Za-z0-9_]/g, "_");
}

/** The bridge: a view in the tab's own catalog over the qualified cloud table. */
export function createViewSql(ref: TableRef): string {
  return `CREATE OR REPLACE VIEW ${quote(viewNameFor(ref))} AS SELECT * FROM ${sqlRef(ref)}`;
}

const quote = (id: string): string => `"${id.replaceAll('"', '""')}"`;

/** The SQL spelling of a ref. */
export function sqlRef(ref: TableRef): string {
  return `${quote(ref.catalog)}.${quote(ref.schema)}.${quote(ref.table)}`;
}

/** Whether a DuckDB type is one the histograms can bin. */
export function isNumericType(dataType: string): boolean {
  return /^(DOUBLE|FLOAT|REAL|DECIMAL|NUMERIC|U?(TINY|SMALL|BIG|HUGE)?INT(EGER)?)\b/i.test(
    dataType,
  );
}

/**
 * Pull the first `rows` rows of a cloud table into the tab: a regular table in
 * `memory`, re-queried at memory speed from then on. `CREATE OR REPLACE`, so a
 * second pull replaces the first.
 */
export function materializeSql(ref: TableRef, rows: number): string {
  const n = Math.max(1, Math.floor(rows));
  return `CREATE OR REPLACE TABLE ${quote(LOCAL_SAMPLE)} AS SELECT * FROM ${sqlRef(ref)} LIMIT ${n}`;
}

/**
 * A hybrid question: how many cloud rows fall inside the local sample's range
 * of `column`? The inner aggregate runs in the tab, the outer scan on the
 * Duckling — dual execution ships the two numbers up, not the rows down.
 */
export function hybridCountSql(ref: TableRef, column: string): string {
  const c = quote(column);
  return (
    `SELECT count(*) AS n FROM ${sqlRef(ref)} r WHERE r.${c} BETWEEN ` +
    `(SELECT min(${c}) FROM ${quote(LOCAL_SAMPLE)}) AND (SELECT max(${c}) FROM ${quote(LOCAL_SAMPLE)})`
  );
}

/** The local sample's own row count — the thing a rebuild loses. */
export const LOCAL_COUNT_SQL = `SELECT count(*) AS n FROM ${quote(LOCAL_SAMPLE)}`;
