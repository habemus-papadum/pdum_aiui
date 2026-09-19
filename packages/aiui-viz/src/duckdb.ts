/**
 * duckdb.ts — instantiate DuckDB-WASM from *app-bundled* assets, plus the
 * byte-progress fetch that usually accompanies loading a dataset into it.
 * Graduated from the seismos notebook (porcelain-by-extraction).
 *
 * Why the bundles are a **parameter** and not imported here: the asset
 * sourcing is the CONSUMING app's deployment decision, and a library cannot
 * do `?url` imports on the app's behalf anyway — in the published dist build
 * they would inline or dangle (the same class of build-time trap as
 * `import.meta.env`; see the workspace packaging conventions). So the app
 * owns the bundle wiring and this module owns the selection/instantiation
 * dance. Two proven wirings:
 *
 * ```ts
 * // Workers app-bundled (`?url` — same-origin, so a plain `new Worker` works
 * // with no cross-origin Blob bootstrap); wasm from jsDelivr, pinned to the
 * // installed version by getJsDelivrBundles(). The default for the in-repo
 * // apps (demos/wine): the ~35–41 MB binaries blow past static-host
 * // per-file limits (Cloudflare Workers assets cap at 25 MiB), and the CDN
 * // copy is immutable and CORS-open.
 * import ehWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url";
 * import mvpWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url";
 * const jsd = getJsDelivrBundles();
 * const db = await instantiateDuckDB({
 *   mvp: { mainModule: jsd.mvp.mainModule, mainWorker: mvpWorker },
 *   eh: { mainModule: jsd.eh.mainModule, mainWorker: ehWorker },
 * });
 * ```
 *
 * ```ts
 * // Fully self-hosted: wasm `?url`-imported too, emitted under the app's
 * // own base and origin — for a deploy that must not depend on a CDN and
 * // whose host has no per-file size cap.
 * import ehWasm from "@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url";
 * import mvpWasm from "@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url";
 * ```
 *
 * Ship only `mvp` + `eh` (no `coi`): the threaded/COI bundle needs
 * SharedArrayBuffer with COOP/COEP cross-origin-isolation headers a static
 * host can't set. `selectBundle` picks `eh` on every modern browser. Pin
 * `@duckdb/duckdb-wasm` to the exact version `@uwdata/mosaic-core` depends on
 * so one deduped copy exists (frontend-hard-won §Mosaic).
 *
 * Lives on its own subpath (`@habemus-papadum/aiui-viz/duckdb`) so
 * `@duckdb/duckdb-wasm` stays an optional peer only DuckDB consumers install.
 *
 * The second half of this module is **the agent's SQL tools** — `sql` and
 * `schema`, registered on a kit by {@link registerSqlTools} — promoted from
 * the seismos and wine notebooks' hand-rolled `query` tools (the tool-docs
 * proposal, docs/proposals/tool-docs.md). The library still owns no
 * connection: the app hands over a {@link SqlRunner}, and two adapters cover
 * the shapes in use — a duckdb-wasm connection ({@link duckdbRunner}) and a
 * Mosaic `Connector` ({@link connectorRunner}, the Quack path, where the SQL
 * string travels). Mosaic stays optional throughout.
 */
import * as duckdb from "@duckdb/duckdb-wasm";
import type { AgentToolkit } from "./agent-tools";

/**
 * Build an AsyncDuckDB from the app's bundles. The worker files are served
 * same-origin, so a plain `new Worker(url)` is enough — no cross-origin Blob
 * shim (which is only why duckdb-wasm's jsDelivr path wraps a Blob).
 *
 * `workerFactory` is the instrumentation seam: an app that must wrap the
 * worker (scratch's mosaic-taxi patches XHR/fetch inside it to meter DuckDB's
 * S3 traffic honestly; a test can hand back a scripted stand-in) receives the
 * selected bundle's worker URL and returns the Worker to use. Module URLs are
 * passed to `instantiate` ABSOLUTE for the factory's sake: a factory that
 * boots the real worker through a `blob:` bootstrap has no usable base URL,
 * and absolute URLs cost a plain `new Worker` nothing.
 */
export async function instantiateDuckDB(
  bundles: duckdb.DuckDBBundles,
  options: {
    logger?: duckdb.Logger;
    workerFactory?: (workerUrl: string) => Worker;
  } = {},
): Promise<duckdb.AsyncDuckDB> {
  const bundle = await duckdb.selectBundle(bundles);
  if (!bundle.mainWorker) throw new Error("duckdb: no worker in selected bundle");
  const worker = options.workerFactory?.(bundle.mainWorker) ?? new Worker(bundle.mainWorker);
  const db = new duckdb.AsyncDuckDB(options.logger ?? new duckdb.VoidLogger(), worker);
  const absolute = (url: string): string => new URL(url, location.href).href;
  await db.instantiate(
    absolute(bundle.mainModule),
    bundle.pthreadWorker === null || bundle.pthreadWorker === undefined
      ? null
      : absolute(bundle.pthreadWorker),
  );
  return db;
}

/**
 * Fetch `url` into memory, reporting fraction-complete from the Content-Length
 * and the streamed byte count. Falls back to a single arrayBuffer read when the
 * body isn't a readable stream (or the length is unknown).
 */
export async function fetchWithProgress(
  url: string,
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`fetch ${url} — ${res.status} ${res.statusText}`);
  const total = Number(res.headers.get("content-length")) || 0;
  const reader = res.body?.getReader();
  if (!reader) {
    const buf = new Uint8Array(await res.arrayBuffer());
    onProgress(1);
    return buf;
  }
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (total > 0) onProgress(Math.min(0.999, received / total));
  }
  const out = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  onProgress(1);
  return out;
}

// ── the agent's SQL tools ─────────────────────────────────────────────────────

/** A query's answer, columnar: names, optional DuckDB type names, rows as
 * arrays (arrays instead of row objects roughly halve the tokens a model
 * reads, and the types come free from Arrow). */
export interface SqlResult {
  columns: string[];
  types?: string[];
  rows: unknown[][];
}

/** What executes SQL. The app owns the database and the coordinator; the
 * tools own only this seam. */
export interface SqlRunner {
  query(sql: string, options?: { signal?: AbortSignal }): Promise<SqlResult>;
  /** Best-effort cancel of the in-flight statement (a timeout calls it). */
  cancel?(): Promise<void>;
}

/** Arrow's row proxies read like objects; this is all we need of them. */
type ArrowLike = {
  schema: { fields: ReadonlyArray<{ name: string; type: unknown }> };
  toArray(): ReadonlyArray<Record<string, unknown>>;
};

/**
 * A runner over a duckdb-wasm connection. Give it a connection DEDICATED to
 * agent reads (the seismos pattern: `db.connect()` twice, one for Mosaic),
 * so a slow agent query never contends with the views' queries.
 */
export function duckdbRunner(connection: duckdb.AsyncDuckDBConnection): SqlRunner {
  return {
    async query(sql) {
      const table = (await connection.query(sql)) as unknown as ArrowLike;
      const columns = table.schema.fields.map((f) => f.name);
      const types = table.schema.fields.map((f) => String(f.type));
      const rows = table.toArray().map((row) => columns.map((c) => row[c]));
      return { columns, types, rows };
    },
    async cancel() {
      await connection.cancelSent();
    },
  };
}

/** The Mosaic `Connector` shape this adapter needs (structural on purpose —
 * no `@uwdata/*` import; the Quack path in apps/cc-miner is one). */
export interface JsonConnector {
  query(request: { type: "json"; sql: string }): Promise<unknown>;
}

/** A runner over a Mosaic connector, asking for JSON rows. No type names —
 * the connector's JSON path drops them; `schema` still answers from
 * `information_schema`. */
export function connectorRunner(connector: JsonConnector): SqlRunner {
  return {
    async query(sql) {
      const answer = (await connector.query({ type: "json", sql })) as unknown;
      const rows = Array.isArray(answer) ? (answer as Array<Record<string, unknown>>) : [];
      const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
      return { columns, rows: rows.map((row) => columns.map((c) => row[c])) };
    },
  };
}

/** Defaults for the caps (see {@link SqlToolsOptions}). */
export const SQL_DEFAULT_LIMIT = 200;
export const SQL_ROW_CAP = 5000;
/** The panel's `read_file` precedent: 32 KB is what a model reads comfortably. */
export const SQL_BYTE_CAP = 32 * 1024;
export const SQL_TIMEOUT_MS = 10_000;
/** Long strings clip here, with a marker, so one wide text column cannot eat
 * the whole byte budget. */
export const SQL_STRING_CAP = 256;

export interface RunSqlOptions {
  /** Rows to return (the tool's `limit`); clamped to [1, `rowCap`]. */
  limit?: number;
  rowCap?: number;
  byteCap?: number;
  timeoutMs?: number;
}

/** The `sql` tool's answer. `truncated.rows` is known exactly (the query
 * asks for one row more than the limit); `truncated.bytes` says the byte
 * budget cut the rows short. */
export interface SqlToolResult extends SqlResult {
  truncated: { rows: boolean; bytes: boolean; limit: number; byteCap: number };
}

const READ_ONLY = /^(select|with)\b/i;

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Make one cell JSON-safe and bounded. */
function cell(value: unknown): unknown {
  if (typeof value === "bigint") {
    const n = Number(value);
    return Number.isSafeInteger(n) ? n : value.toString();
  }
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) return `<${value.byteLength} bytes>`;
  if (typeof value === "string") {
    return value.length > SQL_STRING_CAP ? `${value.slice(0, SQL_STRING_CAP)}…` : value;
  }
  if (value !== null && typeof value === "object") {
    // Nested lists/structs (Arrow vectors read as objects): JSON them, bounded.
    let text: string;
    try {
      text = JSON.stringify(value, (_k, v: unknown) => (typeof v === "bigint" ? Number(v) : v));
    } catch {
      return String(value);
    }
    const cap = SQL_STRING_CAP * 4;
    return text.length > cap ? `${text.slice(0, cap)}…` : (JSON.parse(text) as unknown);
  }
  return value;
}

/**
 * Run one read-only statement with the guards every consumer relies on:
 * `SELECT`/`WITH` only, a single statement, a wrapping `LIMIT` one past the
 * cap (so truncation is detected, not guessed), a byte budget on the rows,
 * bounded cells, and a timeout that cancels the statement. Errors are thrown
 * with DuckDB's message untouched — it carries the position and the
 * candidate names, and every consumer forwards it to the model.
 */
export async function runSql(
  runner: SqlRunner | Promise<SqlRunner>,
  sql: string,
  options: RunSqlOptions = {},
): Promise<SqlToolResult> {
  const rowCap = Math.max(1, Math.floor(options.rowCap ?? SQL_ROW_CAP));
  const limit = Math.max(1, Math.min(rowCap, Math.floor(options.limit ?? SQL_DEFAULT_LIMIT)));
  const byteCap = Math.max(256, Math.floor(options.byteCap ?? SQL_BYTE_CAP));
  const timeoutMs = Math.max(1, Math.floor(options.timeoutMs ?? SQL_TIMEOUT_MS));

  const trimmed = sql.trim().replace(/;\s*$/, "").trim();
  if (!READ_ONLY.test(trimmed)) {
    throw new Error("only read-only SELECT/WITH statements are allowed");
  }
  if (trimmed.includes(";")) {
    throw new Error("one statement at a time — no ';' inside the query");
  }
  const wrapped = `SELECT * FROM (${trimmed}) AS _q LIMIT ${limit + 1}`;

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onTimeout = new Promise<never>((_, reject) => {
    controller.signal.addEventListener(
      "abort",
      () => reject(new Error(`query timed out after ${timeoutMs} ms`)),
      { once: true },
    );
  });
  let result: SqlResult;
  let live: SqlRunner | undefined;
  try {
    live = await Promise.race([
      Promise.resolve(runner),
      onTimeout.catch(() => {
        throw new Error("the database is not loaded yet; try again in a moment");
      }),
    ]);
    result = await Promise.race([live.query(wrapped, { signal: controller.signal }), onTimeout]);
  } catch (err) {
    if (timedOut && live !== undefined) {
      void live.cancel?.().catch(() => {});
    }
    throw new Error(message(err));
  } finally {
    clearTimeout(timer);
  }

  const rows: unknown[][] = [];
  let bytes = 2;
  let bytesCut = false;
  for (const row of result.rows.slice(0, limit)) {
    const out = row.map(cell);
    bytes += JSON.stringify(out).length + 1;
    if (bytes > byteCap && rows.length > 0) {
      bytesCut = true;
      break;
    }
    rows.push(out);
  }
  return {
    columns: result.columns,
    ...(result.types !== undefined ? { types: result.types } : {}),
    rows,
    truncated: { rows: result.rows.length > limit || bytesCut, bytes: bytesCut, limit, byteCap },
  };
}

/** The same answer as a markdown table, for a voice model that summarizes
 * rather than reads rows. */
export function formatMarkdown(result: SqlToolResult): string {
  const text = (v: unknown): string =>
    v === null || v === undefined
      ? ""
      : typeof v === "object"
        ? JSON.stringify(v)
        : String(v).replace(/\|/g, "\\|");
  const lines = [
    `| ${result.columns.join(" | ")} |`,
    `| ${result.columns.map(() => "---").join(" | ")} |`,
    ...result.rows.map((row) => `| ${row.map(text).join(" | ")} |`),
  ];
  const note = result.truncated.rows
    ? `\n(${result.rows.length} rows shown; truncated at ${result.truncated.bytes ? `${result.truncated.byteCap} bytes` : `limit ${result.truncated.limit}`})`
    : `\n(${result.rows.length} rows)`;
  return lines.join("\n") + note;
}

export interface SchemaResult {
  tables: Array<{ name: string; type: string; columns: Array<{ name: string; type: string }> }>;
  /** `SUMMARIZE <table>`, when asked for. */
  summary?: SqlToolResult;
}

const quoteIdent = (name: string): string => `"${name.replace(/"/g, '""')}"`;
const quoteLit = (s: string): string => `'${s.replace(/'/g, "''")}'`;
const USER_SCHEMAS = "table_schema NOT IN ('information_schema', 'pg_catalog')";

/**
 * Tables and columns from `information_schema` (every catalog, minus the
 * system schemas); `summarize` adds DuckDB's `SUMMARIZE` for one table —
 * on request only, since it scans the table.
 */
export async function schemaOf(
  runner: SqlRunner | Promise<SqlRunner>,
  options: { table?: string; summarize?: boolean; timeoutMs?: number } = {},
): Promise<SchemaResult> {
  const only = options.table !== undefined ? ` AND table_name = ${quoteLit(options.table)}` : "";
  const run = (sql: string) =>
    runSql(runner, sql, { limit: SQL_ROW_CAP, byteCap: 1 << 20, timeoutMs: options.timeoutMs });
  const tables = await run(
    `SELECT table_name, table_type FROM information_schema.tables WHERE ${USER_SCHEMAS}${only} ORDER BY table_name`,
  );
  const columns = await run(
    `SELECT table_name, column_name, data_type FROM information_schema.columns WHERE ${USER_SCHEMAS}${only} ORDER BY table_name, ordinal_position`,
  );
  const byTable = new Map<string, SchemaResult["tables"][number]>();
  for (const [name, type] of tables.rows) {
    byTable.set(String(name), { name: String(name), type: String(type), columns: [] });
  }
  for (const [table, column, type] of columns.rows) {
    byTable.get(String(table))?.columns.push({ name: String(column), type: String(type) });
  }
  const out: SchemaResult = { tables: [...byTable.values()] };
  if (options.summarize === true && options.table !== undefined) {
    out.summary = await run(`SELECT * FROM (SUMMARIZE ${quoteIdent(options.table)})`);
  }
  return out;
}

export interface SqlToolsOptions {
  /** The runner, or a promise of one (the database loads later — the tools
   * register now and answer "not loaded yet" until it resolves). */
  runner: SqlRunner | Promise<SqlRunner>;
  /** The tables to name in the tool's usage. Omitted, they are introspected
   * once the runner resolves and the `sql` tool is re-registered with them. */
  tables?: string[];
  rowCap?: number;
  defaultLimit?: number;
  byteCap?: number;
  timeoutMs?: number;
}

/**
 * Register the agent's `sql` and `schema` tools on a kit. Both are reads;
 * both carry their usage (the tool-docs convention): the caps, the table
 * list, "aggregate in SQL rather than fetching rows", and the retry rule.
 * Idempotent by name, like every registration.
 */
export function registerSqlTools(kit: AgentToolkit, options: SqlToolsOptions): void {
  const rowCap = options.rowCap ?? SQL_ROW_CAP;
  const defaultLimit = Math.min(rowCap, options.defaultLimit ?? SQL_DEFAULT_LIMIT);
  const byteCap = options.byteCap ?? SQL_BYTE_CAP;
  const caps = { rowCap, byteCap, timeoutMs: options.timeoutMs };

  const registerSql = (tables: string[] | undefined): void => {
    const tableList =
      tables !== undefined && tables.length > 0
        ? `Tables: ${tables.map((t) => `\`${t}\``).join(", ")} (call schema for their columns and types).`
        : "Call schema first to learn the tables and columns.";
    kit.registerTool({
      name: "sql",
      description: "Run one read-only SQL SELECT/WITH statement against the app's DuckDB database.",
      usage:
        `${tableList} Results come back columnar (columns, types, rows) capped at ${defaultLimit} rows ` +
        `by default (limit up to ${rowCap}) and ${byteCap} bytes; \`truncated\` says when either cut ` +
        "in, so aggregate in SQL rather than fetching rows. An error carries DuckDB's message " +
        'and position: fix the statement and retry. format: "markdown" returns a table instead.',
      kind: "read",
      inputSchema: {
        type: "object",
        properties: {
          sql: { type: "string", description: "one SELECT or WITH statement" },
          limit: {
            type: "number",
            description: `row cap (default ${defaultLimit}, max ${rowCap})`,
          },
          format: { type: "string", enum: ["table", "markdown"] },
        },
        required: ["sql"],
        additionalProperties: false,
      },
      run: async (args) => {
        const sql = String(args?.sql ?? "");
        const limit = typeof args?.limit === "number" ? args.limit : defaultLimit;
        const result = await runSql(options.runner, sql, { ...caps, limit });
        return args?.format === "markdown"
          ? { markdown: formatMarkdown(result), truncated: result.truncated }
          : result;
      },
    });
  };
  registerSql(options.tables);

  kit.registerTool({
    name: "schema",
    description:
      "Describe the app's DuckDB database: its tables and their columns with types; " +
      "optionally DuckDB's SUMMARIZE statistics for one table.",
    usage:
      "Call it before the first sql when you do not know the columns; pass table for one " +
      "table, and summarize: true (with a table) for per-column min/max/nulls — slow on a " +
      "large table, so only when the question needs it.",
    kind: "read",
    inputSchema: {
      type: "object",
      properties: {
        table: { type: "string", description: "one table's name" },
        summarize: { type: "boolean", description: "add SUMMARIZE statistics (needs table)" },
      },
      additionalProperties: false,
    },
    run: (args) =>
      schemaOf(options.runner, {
        ...(typeof args?.table === "string" ? { table: args.table } : {}),
        summarize: args?.summarize === true,
        timeoutMs: options.timeoutMs,
      }),
  });

  // The table list is the one fact the usage should carry and the app
  // should not have to type: introspect once the database is there, and
  // re-register `sql` (replace-by-name, HMR-safe) so every consumer sees it.
  if (options.tables === undefined) {
    void Promise.resolve(options.runner)
      .then((runner) => schemaOf(runner, { timeoutMs: options.timeoutMs }))
      .then((schema) => registerSql(schema.tables.map((t) => t.name)))
      .catch(() => {
        // Introspection is a convenience; the generic usage stands.
      });
  }
}
