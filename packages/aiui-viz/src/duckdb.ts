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
 * string travels); aiui-cf-creds adds `motherDuckRunner` over the MotherDuck
 * client. A runner with `exec` can hold **schema views** ({@link SchemaViewProvider}:
 * the cross-filter's filtered twins, a control-driven subset) that the tools
 * materialize lazily, in a named catalog if asked. Introspection is
 * catalog-aware: a table outside the current catalog is `catalog.schema.name`
 * (a bare name never resolves across catalogs), and `catalogs` narrows the
 * listing. Mosaic stays optional throughout.
 */
import * as duckdb from "@duckdb/duckdb-wasm";
import type { AgentToolkit } from "./agent-tools";

// ── self-hosted assets ────────────────────────────────────────────────────────

/** Where the aiui Vite plugin's `duckdbAssets` option published the binaries. */
export interface DuckdbAssetsLocation {
  /** The app's base, e.g. `/` or `/notes/x/` — what the MotherDuck client's
   * `duckDBAssetsURLPrefix` takes. */
  prefix: string;
  /** The installed `@duckdb/duckdb-wasm` version, the layout's path segment. */
  version: string;
}

/** The directory the layout hangs under — the MotherDuck client's convention. */
export const DUCKDB_ASSETS_DIR = "duckdb-wasm-assets";

/**
 * The location the plugin seeded on the page (`window.__AIUI__.duckdbAssets`),
 * or a loud error naming the remedy: this is the one wiring that MUST be in
 * the app's Vite config, and nothing else can supply it at runtime.
 */
export function duckdbAssetsLocation(global: unknown = globalThis): DuckdbAssetsLocation {
  const aiui = (global as { __AIUI__?: { duckdbAssets?: unknown } }).__AIUI__;
  const location = aiui?.duckdbAssets as Partial<DuckdbAssetsLocation> | undefined;
  if (typeof location?.prefix !== "string" || typeof location.version !== "string") {
    throw new Error(
      "no DuckDB-WASM assets location on the page — add `duckdbAssets: true` to the app's " +
        "`aiui()` Vite plugin options (@habemus-papadum/aiui-source-processor) so the binaries " +
        "are self-hosted at <base>duckdb-wasm-assets/<version>/ and the page knows where",
    );
  }
  return { prefix: location.prefix, version: location.version };
}

/**
 * The `mvp` + `eh` bundles at the self-hosted layout, for
 * {@link instantiateDuckDB}. Same-origin, so a plain `new Worker` works; the
 * same URLs the MotherDuck client forms from `duckDBAssetsURLPrefix`, so a
 * plain-DuckDB app and a MotherDuck app share one asset store.
 */
export function duckdbAssetBundles(
  location: DuckdbAssetsLocation = duckdbAssetsLocation(),
): duckdb.DuckDBBundles {
  const at = (file: string): string =>
    `${location.prefix}${DUCKDB_ASSETS_DIR}/${location.version}/${file}`;
  return {
    mvp: { mainModule: at("duckdb-mvp.wasm"), mainWorker: at("duckdb-browser-mvp.worker.js") },
    eh: { mainModule: at("duckdb-eh.wasm"), mainWorker: at("duckdb-browser-eh.worker.js") },
  };
}

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
  /**
   * Run one statement for its effect — the schema views' DDL (`CREATE
   * SCHEMA`, `CREATE OR REPLACE VIEW`). Only a runner whose database can
   * HOLD catalog state across calls, and may receive it, implements this:
   * duckdb-wasm does; a fresh-session connector cannot, and a remote
   * database must not be written to. Without it, schema views are reported
   * by their body text instead of materialized (see {@link SchemaViewProvider}).
   */
  exec?(sql: string): Promise<void>;
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
    async exec(sql) {
      await connection.query(sql);
    },
  };
}

/** The Mosaic `Connector` shape this adapter needs (structural on purpose —
 * no `@uwdata/*` import; the Quack path in the cc-miner app, now its own repo, is one). */
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

export interface SchemaTable {
  /** The name to write after FROM: bare in the current catalog's `main`
   * schema, `schema.name` elsewhere in that catalog, `catalog.schema.name`
   * in another attached catalog (a bare name never resolves across
   * catalogs — DuckDB only searches the current one). */
  name: string;
  /** The schema it lives in. */
  schema: string;
  /** The catalog (attached database) it lives in, when the runner said. */
  catalog?: string;
  /** `BASE TABLE` or `VIEW`, as information_schema says. */
  type: string;
  columns: Array<{ name: string; type: string }>;
  /** The schema views (see {@link SchemaViewProvider}) that are views OF this table. */
  views?: string[];
}

export interface SchemaResult {
  tables: SchemaTable[];
  /** The current catalog — what a bare name resolves in — when the runner said. */
  catalog?: string;
  /** The schema views a provider contributed, with their provenance (see
   * {@link SchemaViewStatus}); absent when the tools registered none. */
  views?: SchemaViewStatus[];
  /** `SUMMARIZE <table>`, when asked for. */
  summary?: SqlToolResult;
}

const quoteIdent = (name: string): string => `"${name.replace(/"/g, '""')}"`;
const quoteLit = (s: string): string => `'${s.replace(/'/g, "''")}'`;
const USER_SCHEMAS = "table_schema NOT IN ('information_schema', 'pg_catalog')";
/** DuckDB's own catalogs, and MotherDuck's metadata catalog: never data. */
const SYSTEM_CATALOGS = "table_catalog NOT IN ('system', 'temp', 'md_information_schema')";

/**
 * What to write after FROM: the bare name in the current catalog's `main`,
 * `schema.name` elsewhere in that catalog, and `catalog.schema.name` in
 * another catalog (given both the table's and the current one).
 */
export function qualifiedTableName(
  schema: string,
  name: string,
  catalog?: string,
  current?: string,
): string {
  const bareSchema = schema === "main" || schema === "";
  if (catalog !== undefined && current !== undefined && catalog !== current) {
    return `${catalog}.${bareSchema ? "main" : schema}.${name}`;
  }
  return bareSchema ? name : `${schema}.${name}`;
}

/** A `catalog.schema.name`, `schema.name` or bare `name` back into its parts. */
function splitTableName(name: string): { catalog?: string; schema?: string; name: string } {
  const parts = name.split(".");
  const bare = parts.pop() ?? name;
  const schema = parts.pop();
  const catalog = parts.pop();
  return {
    ...(catalog !== undefined ? { catalog } : {}),
    ...(schema !== undefined ? { schema } : {}),
    name: bare,
  };
}

/** The SQL to name a table in a statement: every dotted part quoted. */
function tableRef(name: string): string {
  return name
    .split(".")
    .map((part) => quoteIdent(part))
    .join(".");
}

/**
 * Tables and columns from `information_schema` — every attached catalog
 * minus the system ones, or the `catalogs` asked for — named the way FROM
 * takes them ({@link qualifiedTableName}: a table in another catalog is
 * `catalog.schema.name`, and two catalogs' same-named tables stay two
 * entries). `summarize` adds DuckDB's `SUMMARIZE` for one table — on
 * request only, since it scans the table.
 */
export async function schemaOf(
  runner: SqlRunner | Promise<SqlRunner>,
  options: {
    table?: string;
    summarize?: boolean;
    timeoutMs?: number;
    /** List only these catalogs (attached databases); default: every one. */
    catalogs?: readonly string[];
  } = {},
): Promise<SchemaResult> {
  const want = options.table !== undefined ? splitTableName(options.table) : undefined;
  const only =
    (want === undefined
      ? ""
      : ` AND table_name = ${quoteLit(want.name)}` +
        (want.schema !== undefined ? ` AND table_schema = ${quoteLit(want.schema)}` : "") +
        (want.catalog !== undefined ? ` AND table_catalog = ${quoteLit(want.catalog)}` : "")) +
    (options.catalogs !== undefined && options.catalogs.length > 0
      ? ` AND table_catalog IN (${options.catalogs.map(quoteLit).join(", ")})`
      : "");
  const run = (sql: string) =>
    runSql(runner, sql, { limit: SQL_ROW_CAP, byteCap: 1 << 20, timeoutMs: options.timeoutMs });
  // Read by column name: a runner that answers with fewer columns (no
  // schema or catalog column) still works, as `main` in the current catalog.
  const pick = (result: SqlResult, row: unknown[], name: string, fallback = ""): string => {
    const i = result.columns.indexOf(name);
    return i === -1 ? fallback : String(row[i]);
  };
  const tables = await run(
    `SELECT table_catalog, table_schema, table_name, table_type FROM information_schema.tables WHERE ${USER_SCHEMAS} AND ${SYSTEM_CATALOGS}${only} ORDER BY table_catalog, table_schema, table_name`,
  );
  const columns = await run(
    `SELECT table_catalog, table_schema, table_name, column_name, data_type FROM information_schema.columns WHERE ${USER_SCHEMAS} AND ${SYSTEM_CATALOGS}${only} ORDER BY table_catalog, table_schema, table_name, ordinal_position`,
  );
  // The current catalog names the rest; a runner that cannot say (a server
  // behind a JSON connector, say) still gets the listing, unqualified.
  let current: string | undefined;
  try {
    const currentRows = await run("SELECT current_database() AS catalog");
    const cell = currentRows.rows[0]?.[currentRows.columns.indexOf("catalog")];
    if (typeof cell === "string" && cell !== "") current = cell;
  } catch {
    current = undefined;
  }
  const nameOf = (
    result: SqlResult,
    row: unknown[],
  ): { name: string; schema: string; catalog?: string } => {
    const schema = pick(result, row, "table_schema", "main");
    const catalog = pick(result, row, "table_catalog", current ?? "");
    return {
      name: qualifiedTableName(
        schema,
        pick(result, row, "table_name"),
        catalog === "" ? undefined : catalog,
        current,
      ),
      schema,
      ...(catalog === "" ? {} : { catalog }),
    };
  };
  const byTable = new Map<string, SchemaTable>();
  for (const row of tables.rows) {
    const id = nameOf(tables, row);
    byTable.set(id.name, { ...id, type: pick(tables, row, "table_type"), columns: [] });
  }
  for (const row of columns.rows) {
    byTable.get(nameOf(columns, row).name)?.columns.push({
      name: pick(columns, row, "column_name"),
      type: pick(columns, row, "data_type"),
    });
  }
  const out: SchemaResult = {
    tables: [...byTable.values()],
    ...(current !== undefined ? { catalog: current } : {}),
  };
  if (options.summarize === true && options.table !== undefined) {
    out.summary = await run(`SELECT * FROM (SUMMARIZE ${tableRef(options.table)})`);
  }
  return out;
}

// ── schema views ──────────────────────────────────────────────────────────

/**
 * One view a provider contributes to the database the agent sees:
 * `<schema>.<name>`, usually a filtered twin of a base table (`of`). The
 * body is read when the view is (re)materialized; the provenance rides in
 * the `schema` tool's answer so the model knows what it is looking at.
 */
export interface SchemaView {
  /** The schema the view lives in — the provider's word (`crossfilter`). */
  schema: string;
  /** The view's name; a filtered twin keeps its base table's name. */
  name: string;
  /** The base table this is a view of, when it is one. */
  of?: string;
  /** The body: one SELECT over the base tables. Read at materialization. */
  sql(): string;
  /** Provenance for the `schema` tool: what the view is, what filters it,
   * which tool changes it. Read on every `schema` call. */
  describe(): Record<string, unknown>;
}

/**
 * Something that contributes views to the agent's database — the cross-
 * filter (aiui-viz/crossfilter), a control-driven subset, a named view…
 * The SQL tools own what follows: materializing the views as real DuckDB
 * views in their schema (when the runner can hold them — see
 * {@link SqlRunner.exec}), refreshing them lazily before the next `sql` or
 * `schema` call once the provider signalled a change, listing them with
 * provenance in `schema`, and naming them in `sql`'s usage. The provider
 * knows nothing of the tools; the tools know nothing of what filters.
 */
export interface SchemaViewProvider {
  /** A short id for the provenance (`cross-filter`, `control`). */
  id: string;
  /** The views, given the base tables the tools introspected (so a provider
   * can learn columns, or offer a view per table it covers). */
  views(tables: readonly SchemaTable[]): SchemaView[];
  /** Fires when a view's body may have changed. Absent ⇒ the bodies are
   * re-read before every call (a body that did not change costs no DDL). */
  subscribe?(onChange: () => void): () => void;
  /** The base tables this provider would cover were they present — lets the
   * tools notice a table that appeared since the last introspection (a view
   * bridging a picked cloud table) and look again before the next call. */
  wants?(): readonly string[];
}

/** One schema view as the `schema` tool reports it. */
export interface SchemaViewStatus {
  /** `schema.name` — what FROM takes. */
  name: string;
  of?: string;
  provider: string;
  /** True when the view exists in the database; false when this runner
   * cannot hold one, in which case `sql` carries the body to inline. */
  materialized: boolean;
  /** The body, when not materialized (use it as a subquery or a CTE). */
  sql?: string;
  /** The provider's provenance (see {@link SchemaView.describe}). */
  about: Record<string, unknown>;
  /** The materialization error, when the last attempt failed. */
  error?: string;
}

/** Options for {@link SchemaViews}. */
interface SchemaViewsOptions {
  providers: readonly SchemaViewProvider[];
  /** Prefix the views' schemas with this catalog (`memory` beside a remote
   * database), so a cloud database never receives them. */
  catalog?: string;
  /**
   * Read before every refresh: when the value differs from the last one,
   * everything materialized is forgotten and issued again — the database
   * was rebuilt (an engine generation, say) and holds none of it any more.
   */
  epoch?: () => unknown;
  /** The base tables as of now, when a provider `wants` one the last
   * introspection did not list. */
  introspect?: () => Promise<readonly SchemaTable[]>;
}

/**
 * The materializer: the state behind the `sql`/`schema` tools' views. Lazy —
 * `refresh` runs before a tool call, and only re-issues DDL for a view whose
 * body changed (text equality), so a brush drag marks dirty and costs one
 * `CREATE OR REPLACE VIEW` at the next call, not one per event.
 */
export class SchemaViews {
  private readonly providers: readonly SchemaViewProvider[];
  private readonly catalog: string | undefined;
  private tables: readonly SchemaTable[] = [];
  private tablesSignature = "";
  private dirty = true;
  /** `schema.name` → the body last materialized. */
  private readonly bodies = new Map<string, string>();
  private readonly schemasMade = new Set<string>();
  private readonly epoch: (() => unknown) | undefined;
  private lastEpoch: unknown;
  private readonly introspect: (() => Promise<readonly SchemaTable[]>) | undefined;
  /** Wanted tables the last introspection did not find: not asked again until a new want. */
  private missing = new Set<string>();
  private current: Array<{ view: SchemaView; status: SchemaViewStatus }> = [];
  private readonly onNames = new Set<(names: string[]) => void>();
  private names: string[] = [];

  constructor(options: SchemaViewsOptions) {
    this.providers = options.providers;
    this.catalog = options.catalog;
    this.epoch = options.epoch;
    this.introspect = options.introspect;
    for (const p of this.providers) {
      p.subscribe?.(() => {
        this.dirty = true;
      });
    }
  }

  /** The base tables providers see; call after every introspection — a
   * table created since the last one (a view bridging a picked cloud table,
   * say) becomes coverable here. Dirty only when the set changed. */
  setTables(tables: readonly SchemaTable[]): void {
    const next = tables.filter((t) => !this.schemasMade.has(t.schema));
    // What the providers want and this introspection did not find: not
    // looked for again until the next introspection or epoch.
    const names = new Set(next.map((t) => t.name));
    this.missing = new Set(this.wants().filter((t) => !names.has(t)));
    const signature = next
      .map((t) => `${t.name}:${t.columns.map((c) => c.name).join(",")}`)
      .join("\n");
    if (signature === this.tablesSignature) return;
    this.tablesSignature = signature;
    this.tables = next;
    this.dirty = true;
  }

  private wants(): string[] {
    return this.providers.flatMap((p) => [...(p.wants?.() ?? [])]);
  }

  /** The views' FROM-able names as of the last refresh. */
  viewNames(): string[] {
    return [...this.names];
  }

  /** Fires when the SET of view names changes (bodies changing is not an event). */
  onViewNames(fn: (names: string[]) => void): () => void {
    this.onNames.add(fn);
    return () => this.onNames.delete(fn);
  }

  /** Every provider's views and their status as of the last refresh. */
  status(): SchemaViewStatus[] {
    return this.current.map((c) => ({ ...c.status, about: c.view.describe() }));
  }

  private qualified(view: SchemaView): string {
    const schema = this.catalog !== undefined ? `${this.catalog}.${view.schema}` : view.schema;
    return `${schema}.${view.name}`;
  }

  /**
   * Bring the database's views up to date with the providers: materialize
   * through the runner's `exec` when it has one, else carry the bodies in
   * the status for the tools to report. Never throws — a failing view is
   * reported with its error and the user's statement still runs.
   */
  async refresh(runner: SqlRunner | Promise<SqlRunner>): Promise<void> {
    if (this.epoch !== undefined) {
      const epoch = this.epoch();
      if (epoch !== this.lastEpoch) {
        // A rebuilt database holds nothing of what was materialized.
        this.lastEpoch = epoch;
        this.bodies.clear();
        this.schemasMade.clear();
        this.missing.clear();
        this.dirty = true;
      }
    }
    if (this.introspect !== undefined) {
      // A provider wants a table the last introspection did not list: look
      // again, once per new want (a table that is truly absent stays absent).
      const known = new Set(this.tables.map((t) => t.name));
      if (this.wants().some((t) => !known.has(t) && !this.missing.has(t))) {
        try {
          this.setTables(await this.introspect());
        } catch {
          // Introspection is a convenience; the views stand on what is known.
        }
      }
    }
    const always = this.providers.some((p) => p.subscribe === undefined);
    if (!this.dirty && !always) return;
    this.dirty = false;
    const views = this.providers.flatMap((p) =>
      p.views(this.tables).map((view) => ({ provider: p.id, view })),
    );
    const live = await Promise.resolve(runner);
    const canHold = typeof live.exec === "function";
    const next: Array<{ view: SchemaView; status: SchemaViewStatus }> = [];
    const keep = new Set<string>();
    for (const { provider, view } of views) {
      const name = this.qualified(view);
      keep.add(name);
      let body: string;
      try {
        body = view.sql();
      } catch (err) {
        next.push({
          view,
          status: {
            name,
            ...(view.of !== undefined ? { of: view.of } : {}),
            provider,
            materialized: false,
            about: {},
            error: message(err),
          },
        });
        continue;
      }
      const status: SchemaViewStatus = {
        name,
        ...(view.of !== undefined ? { of: view.of } : {}),
        provider,
        materialized: false,
        about: {},
      };
      if (!canHold || live.exec === undefined) {
        status.sql = body;
      } else if (this.bodies.get(name) === body) {
        status.materialized = true;
      } else {
        try {
          const schemaName =
            this.catalog !== undefined ? `${this.catalog}.${view.schema}` : view.schema;
          if (!this.schemasMade.has(view.schema)) {
            await live.exec(`CREATE SCHEMA IF NOT EXISTS ${schemaRef(schemaName)}`);
            this.schemasMade.add(view.schema);
          }
          await live.exec(`CREATE OR REPLACE VIEW ${tableRef(name)} AS ${body}`);
          this.bodies.set(name, body);
          status.materialized = true;
        } catch (err) {
          status.sql = body;
          status.error = message(err);
          this.bodies.delete(name);
        }
      }
      next.push({ view, status });
    }
    // Views a provider stopped offering: drop them from the database.
    for (const stale of [...this.bodies.keys()].filter((n) => !keep.has(n))) {
      this.bodies.delete(stale);
      if (live.exec !== undefined) {
        await live.exec(`DROP VIEW IF EXISTS ${tableRef(stale)}`).catch(() => {});
      }
    }
    this.current = next;
    const names = next.map((c) => c.status.name);
    if (names.join("\n") !== this.names.join("\n")) {
      this.names = names;
      for (const fn of [...this.onNames]) fn([...names]);
    }
  }
}

/** The SQL to name a schema: `catalog.schema` quoted part by part. */
function schemaRef(name: string): string {
  return name
    .split(".")
    .map((part) => quoteIdent(part))
    .join(".");
}

export interface SqlToolsOptions {
  /** The runner, or a promise of one (the database loads later — the tools
   * register now and answer "not loaded yet" until it resolves). Resolve it
   * once the TABLES exist, not when the connection opens: the table list is
   * introspected once, the moment the promise settles, and an empty catalog
   * leaves the generic usage in place. */
  runner: SqlRunner | Promise<SqlRunner>;
  /** The tables to name in the tool's usage. Omitted, they are introspected
   * once the runner resolves and the `sql` tool is re-registered with them. */
  tables?: string[];
  rowCap?: number;
  defaultLimit?: number;
  byteCap?: number;
  timeoutMs?: number;
  /**
   * Views to add to the database the agent sees (see
   * {@link SchemaViewProvider}): the cross-filter's filtered twins, a
   * control-driven subset… Materialized through the runner's `exec` when it
   * has one; reported by body otherwise.
   */
  views?: readonly SchemaViewProvider[];
  /** Put the views in this catalog (`memory` beside a remote database). */
  viewCatalog?: string;
  /**
   * The catalogs (attached databases) `schema` lists and the usage names —
   * a list, or a function read at each call (the picked database beside
   * the tab's own). Default: every attached catalog but the system ones.
   */
  catalogs?: readonly string[] | (() => readonly string[] | undefined);
  /**
   * Read before every call: when it changes, the views are re-created at
   * that call — for a database that gets rebuilt under the tools (the
   * MotherDuck engine's generation, whose tab catalog starts empty).
   */
  viewEpoch?: () => unknown;
}

/** The tables the usage lists and the view providers build on: the current catalog's `main`. */
function baseTablesOf(schema: SchemaResult): SchemaTable[] {
  return schema.tables.filter(
    (t) =>
      (t.catalog === undefined || schema.catalog === undefined || t.catalog === schema.catalog) &&
      (t.schema === "main" || t.schema === ""),
  );
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
  const catalogsNow = (): { catalogs?: readonly string[] } => {
    const c = typeof options.catalogs === "function" ? options.catalogs() : options.catalogs;
    return c !== undefined ? { catalogs: c } : {};
  };
  const views =
    options.views !== undefined && options.views.length > 0
      ? new SchemaViews({
          providers: options.views,
          ...(options.viewCatalog !== undefined ? { catalog: options.viewCatalog } : {}),
          ...(options.viewEpoch !== undefined ? { epoch: options.viewEpoch } : {}),
          introspect: async () =>
            baseTablesOf(
              await schemaOf(options.runner, { timeoutMs: options.timeoutMs, ...catalogsNow() }),
            ),
        })
      : undefined;
  let knownTables: string[] | undefined = options.tables;

  const registerSql = (tables: string[] | undefined): void => {
    const tableList =
      tables !== undefined && tables.length > 0
        ? `Tables: ${tables.map((t) => `\`${t}\``).join(", ")} (call schema for their columns and types).`
        : "Call schema first to learn the tables and columns.";
    const viewNames = views?.viewNames() ?? [];
    const viewList =
      viewNames.length > 0
        ? ` Views: ${viewNames.map((v) => `\`${v}\``).join(", ")} — each a filtered twin of the table it is named after (schema says by what); query one to ask about the current subset, the base table for everything.`
        : "";
    kit.registerTool({
      name: "sql",
      description: "Run one read-only SQL SELECT/WITH statement against the app's DuckDB database.",
      usage:
        `${tableList}${viewList} Results come back columnar (columns, types, rows) capped at ${defaultLimit} rows ` +
        `by default (limit up to ${rowCap}) and ${byteCap} bytes; \`truncated\` says when either cut ` +
        "in, so aggregate in SQL rather than fetching rows. An error carries DuckDB's message " +
        'and position: fix the statement and retry. format: "markdown" returns a table instead.',
      kind: "read",
      group: "sql",
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
        if (views !== undefined) await views.refresh(options.runner);
        const result = await runSql(options.runner, sql, { ...caps, limit });
        // The views the statement names, with what filtered them at this moment.
        // A view in a named catalog answers to `schema.name` as well.
        const used = (views?.status() ?? []).filter(
          (v) => sql.includes(v.name) || sql.includes(v.name.split(".").slice(-2).join(".")),
        );
        const extra =
          used.length > 0
            ? {
                views: Object.fromEntries(
                  used.map((v) => [
                    v.name,
                    { ...v.about, ...(v.sql !== undefined ? { sql: v.sql } : {}) },
                  ]),
                ),
              }
            : {};
        return args?.format === "markdown"
          ? { markdown: formatMarkdown(result), truncated: result.truncated, ...extra }
          : { ...result, ...extra };
      },
    });
  };
  registerSql(options.tables);
  views?.onViewNames(() => registerSql(knownTables));

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
    group: "sql",
    inputSchema: {
      type: "object",
      properties: {
        table: { type: "string", description: "one table's name" },
        summarize: { type: "boolean", description: "add SUMMARIZE statistics (needs table)" },
      },
      additionalProperties: false,
    },
    run: async (args) => {
      if (views !== undefined) await views.refresh(options.runner);
      let schema = await schemaOf(options.runner, {
        ...(typeof args?.table === "string" ? { table: args.table } : {}),
        summarize: args?.summarize === true,
        timeoutMs: options.timeoutMs,
        ...catalogsNow(),
      });
      if (views === undefined) return schema;
      if (typeof args?.table !== "string") {
        // The base tables as of NOW: one created since registration becomes
        // coverable here; when that minted or dropped a view, introspect once
        // more so the table list carries it. The usage's table list follows.
        const base = baseTablesOf(schema);
        const namesBefore = views.viewNames().join("\n");
        views.setTables(base);
        await views.refresh(options.runner);
        if (views.viewNames().join("\n") !== namesBefore) {
          schema = await schemaOf(options.runner, {
            timeoutMs: options.timeoutMs,
            ...catalogsNow(),
          });
        }
        if (options.tables === undefined) {
          const names = base.map((t) => t.name);
          if (names.join("\n") !== (knownTables ?? []).join("\n")) {
            knownTables = names;
            registerSql(knownTables);
          }
        }
      }
      const status = views.status();
      // Each base table lists the views that are views OF it; a materialized
      // view that information_schema already listed keeps its row.
      for (const t of schema.tables) {
        const mine = status.filter((v) => v.of === t.name).map((v) => v.name);
        if (mine.length > 0) t.views = mine;
      }
      return { ...schema, views: status };
    },
  });

  // The table list is the one fact the usage should carry and the app
  // should not have to type: introspect once the database is there, and
  // re-register `sql` (replace-by-name, HMR-safe) so every consumer sees it.
  // The view providers get the same introspection (their base tables), and
  // the first refresh follows so the view names ride the same usage.
  if (options.tables === undefined || views !== undefined) {
    void Promise.resolve(options.runner)
      .then((runner) => schemaOf(runner, { timeoutMs: options.timeoutMs, ...catalogsNow() }))
      .then(async (schema) => {
        const base = baseTablesOf(schema);
        if (options.tables === undefined) knownTables = base.map((t) => t.name);
        if (views !== undefined) {
          views.setTables(base);
          await views.refresh(options.runner);
        }
        registerSql(knownTables);
      })
      .catch(() => {
        // Introspection is a convenience; the generic usage stands.
      });
  }
}
