/**
 * motherduck.ts — the in-tab MotherDuck engine for aiui apps: the kit's
 * `motherDuckEngine` (`cf-creds-motherduck`) over a token source, composed
 * the way the oracle's key chain is composed — a DEV key injected by the aiui
 * Vite plugin (dev serve only) wins, else the broker route under the key
 * contract. The engine it yields is one stock duckdb-wasm `AsyncDuckDB` with
 * the MotherDuck extension attached: hand `db` + a connection to Mosaic's
 * `wasmConnector`, another connection to `duckdbRunner` for the agent's
 * `sql`/`schema` tools, and materialize local tables beside the cloud ones.
 *
 * Three facts the kit measured (2026-09-24) and this module inherits: the
 * token is consumed once, at connect; a live session outlives its token
 * (expiry, revocation, a replica wake-up after cooldown — local tables
 * intact); so the engine never rebuilds on rotation by itself — `rebuild()`
 * is explicit and app-timed, and `onRebuild` is where the app re-wires Mosaic
 * and re-materializes. `accessMode: "read_only"` is refused by the kit: the
 * read-scaling token is what makes the cloud read-only.
 *
 * The dev key is `window.__AIUI__.devKeys.motherduck`, seeded only under
 * `vite serve` by `aiui({ devKeys: ["motherduck"] })` from
 * `MOTHERDUCK_BROWSER_TOKEN` (env in a source checkout, the OS vault
 * otherwise) — a READ-SCALING token of your own MotherDuck user, never the
 * admin token. A built page never carries it, so production is the broker.
 *
 * One typing seam lives here on purpose. The client vendors its own copy of
 * duckdb-wasm's classes, and TypeScript treats classes with protected members
 * nominally, so the kit's handle (typed against the client's copy) is not
 * assignable to what Mosaic's `wasmConnector` and aiui-viz's `duckdbRunner`
 * take (`@duckdb/duckdb-wasm`'s). Same objects at runtime — the client boots
 * the stock build — so this module re-types the handle ONCE, at the boundary,
 * and every aiui consumer sees the stock types it already has.
 *
 * And one rule, measured 2026-09-24: **`MD_ALL_DATABASES()` must never run
 * under duckdb-wasm's blocking `RUN_QUERY` protocol.** Through
 * `connection.query()` (and Mosaic's `runQuery`) it never returns and takes
 * every connection on the engine down with it — one worker, one queue; the
 * same statement on the same raw connection through the pending-query
 * protocol (`connection.send()`, which is what the client's `evaluateQuery`
 * rides under its sequencer) answers in about 200 ms. `md_user_info()`,
 * `md_live_duckling_size()`, `duckdb_databases()`, `information_schema.*`,
 * `DESCRIBE` and every table scan are fine either way. So: Mosaic keeps a raw
 * connection (its generated SQL never calls an `md_*` function), and the
 * agent's free-form `sql` tool — where a model WILL type `MD_ALL_DATABASES()`
 * — runs through {@link motherDuckRunner}, the runner over the client's
 * `evaluateQuery`. It also gives the tool DuckDB's own type names. The record
 * (probes, the two protocols, the choices if this is revisited) is aiui-viz's
 * duckdb-mosaic.md, Part 4b, "The RUN_QUERY wedge".
 */
import type { AsyncDuckDB, AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import type { SqlResult, SqlRunner } from "@habemus-papadum/aiui-viz/duckdb";
import {
  createMotherDuckCredentialManager,
  type MotherDuckEngine as KitEngine,
  type MotherDuckEngineHandle as KitHandle,
  MOTHERDUCK_CREDENTIALS_PATH,
  type MotherDuckEngineOptions,
  type MotherDuckEngineParams,
  motherDuckEngine,
  staticMotherDuckToken,
  type TokenSource,
} from "@habemus-papadum/cf-creds-motherduck";
import { type BrokerOptions, brokerRoute } from "./shared";

export type { MotherDuckEngineParams, TokenSource } from "@habemus-papadum/cf-creds-motherduck";
export { isMotherDuckAuthError } from "@habemus-papadum/cf-creds-motherduck";

/** A live engine generation, in the stock duckdb-wasm types aiui consumers hold. */
export interface MotherDuckEngineHandle {
  /** The stock instance — what Mosaic's `wasmConnector({ duckdb, connection })` takes. */
  db: AsyncDuckDB;
  /** The client's own sequenced connection (`evaluateQuery`, prepared statements). */
  connection: KitHandle["connection"];
  /** A dedicated stock connection on the same engine — one for Mosaic, one for `duckdbRunner`, … */
  connect(): Promise<AsyncDuckDBConnection>;
  /** Increments on every rebuild; a consumer holding a handle can tell it is stale. */
  generation: number;
}

/** The kit's engine, re-typed at the boundary (see the module doc). */
export interface MotherDuckEngine {
  ready(): Promise<MotherDuckEngineHandle>;
  rebuild(reason?: string): Promise<MotherDuckEngineHandle>;
  onRebuild(fn: (handle: MotherDuckEngineHandle, reason: string) => void): () => void;
  readonly generation: number;
  close(): Promise<void>;
}

/** One cell of a client result, JSON-safe: DuckDB's value objects (dates,
 * decimals, lists, structs) render through their own `toString`, which is
 * DuckDB's own text form; bigints become numbers when safe. */
function plain(value: unknown): unknown {
  if (typeof value === "bigint") {
    const n = Number(value);
    return Number.isSafeInteger(n) ? n : value.toString();
  }
  if (
    value !== null &&
    typeof value === "object" &&
    !(value instanceof Date) &&
    !(value instanceof Uint8Array) &&
    !Array.isArray(value) &&
    typeof (value as { toString?: unknown }).toString === "function" &&
    (value as { toString: unknown }).toString !== Object.prototype.toString
  ) {
    return String(value);
  }
  return value;
}

/**
 * The agent's SQL runner over the client's connection — sequenced by the
 * client, safe for `md_*` catalog functions (see the module doc), and typed
 * by DuckDB itself (`columnType`). Hand it to aiui-viz's `registerSqlTools`.
 * No `cancel`: the client cancels queued queries only, not `evaluateQuery`.
 */
export function motherDuckRunner(connection: MotherDuckEngineHandle["connection"]): SqlRunner {
  return {
    async query(sql): Promise<SqlResult> {
      const { data } = await connection.evaluateQuery(sql);
      const columns = [...data.deduplicatedColumnNames()];
      const types = columns.map((_, i) => String(data.columnType(i)));
      const rows = data.toRows().map((row) => columns.map((c) => plain(row[c])));
      return { columns, types, rows };
    },
  };
}

/** Same objects, the stock declarations: a cast, kept in one function. */
function stock(handle: KitHandle): MotherDuckEngineHandle {
  return handle as unknown as MotherDuckEngineHandle;
}

function adapt(kit: KitEngine): MotherDuckEngine {
  return {
    ready: () => kit.ready().then(stock),
    rebuild: (reason) => kit.rebuild(reason).then(stock),
    onRebuild: (fn) => kit.onRebuild((handle, reason) => fn(stock(handle), reason)),
    get generation() {
      return kit.generation;
    },
    close: () => kit.close(),
  };
}

export interface MotherDuckEngineComposeOptions extends MotherDuckEngineOptions {
  /**
   * The client's connection params — `sessionName`, `customUserAgent`,
   * `duckDBAssetsURLPrefix` (self-hosted wasm), `attachMode`, … — never
   * `mdToken` (the source supplies it) and never `accessMode: "read_only"`.
   */
  params?: MotherDuckEngineParams;
}

export interface BrokerMotherDuckOptions extends BrokerOptions, MotherDuckEngineComposeOptions {
  /** Reuse a source built elsewhere (an app-wide manager); default: the
   * kit's manager on the conventional route with `brokerUrl` + `key`. */
  source?: TokenSource;
}

/** The global the aiui Vite plugin seeds (`aiui-viz`'s `__AIUI__`), structurally. */
type AiuiGlobal = { __AIUI__?: { devKeys?: Record<string, string> } };

/**
 * The dev key the aiui Vite plugin injected (`devKeys: ["motherduck"]`), or
 * undefined — absent in every built page, and in dev unless opted in.
 */
export function devMotherDuckToken(global: unknown = globalThis): string | undefined {
  const key = (global as AiuiGlobal).__AIUI__?.devKeys?.motherduck;
  return typeof key === "string" && key !== "" ? key : undefined;
}

/**
 * An engine over the injected dev key. Throws at construction when none is
 * injected (the same posture as the oracle's `devKeySource`): a page that
 * asks for the dev engine and has no key is misconfigured, not degraded.
 */
export function devMotherDuckEngine(
  options: MotherDuckEngineComposeOptions = {},
  global: unknown = globalThis,
): MotherDuckEngine {
  const token = devMotherDuckToken(global);
  if (token === undefined) {
    throw new Error(
      "no motherduck dev key injected (the aiui vite plugin's devKeys option, dev serve only; " +
        "`aiui keys set motherduck` stores a read-scaling token as MOTHERDUCK_BROWSER_TOKEN)",
    );
  }
  const { params, ...engine } = options;
  return adapt(motherDuckEngine(staticMotherDuckToken(token), params, engine));
}

/**
 * An engine over the broker route: the page names only itself (`key`), the
 * broker's motherduck grant names the lane (service account, TTL), and the
 * manager keeps a fresh token at hand for the next (re)build.
 */
export function brokerMotherDuckEngine(options: BrokerMotherDuckOptions = {}): MotherDuckEngine {
  const { source, brokerUrl, key, params, ...engine } = options;
  const manager =
    source ??
    createMotherDuckCredentialManager({
      url: brokerRoute(MOTHERDUCK_CREDENTIALS_PATH, brokerUrl, key),
    });
  return adapt(motherDuckEngine(manager, params, engine));
}

/**
 * The standard composition, decided at construction: the dev key when the
 * plugin injected one (dev serve, no broker needed), else the broker. Compose
 * the pieces yourself for a different order.
 */
export function standardMotherDuckEngine(
  options: BrokerMotherDuckOptions = {},
  global: unknown = globalThis,
): MotherDuckEngine {
  return devMotherDuckToken(global) !== undefined
    ? devMotherDuckEngine(options, global)
    : brokerMotherDuckEngine(options);
}
