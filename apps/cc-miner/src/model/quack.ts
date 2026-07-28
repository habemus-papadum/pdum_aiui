/**
 * quack.ts — the connector that makes every query run in the DuckDB host.
 *
 * cc-miner used to fetch eight Parquet files into the tab and query them with
 * duckdb-wasm. It no longer does. A native DuckDB process holds the data and
 * answers over Quack (DuckDB's HTTP remote protocol); the page's duckdb-wasm is
 * kept for exactly one job — speaking Quack's binary wire format so we do not
 * have to implement it.
 *
 * The measurement that forced this shape (docs/guide/duckdb-mosaic.md):
 * `ATTACH`-ing the remote catalog performs **no pushdown at all** — a bare
 * `count(*)` over a 272 MB table moved 5.26 GB in 1853 round trips — whereas
 * `quack_query`, which ships the SQL as a string, answered it in 5 ms with ~0
 * bytes. So the SQL must travel, not the table.
 *
 * We delegate to Mosaic's own `wasmConnector` and rewrite only the SQL.
 * Returning duckdb-wasm's result directly does NOT work: it is an apache-arrow
 * table and Mosaic wants flechette (`data.toColumns is not a function`).
 * `wasmConnector` already does that decode, so wrapping it is both shorter and
 * more correct than reimplementing it.
 */
import type { Connector, ConnectorQueryRequest } from "@uwdata/mosaic-core";
import { wasmConnector } from "@uwdata/vgplot";

/** What `/__duckdb-host` answers. The port is deliberately absent. */
export interface HostInfo {
  ok: boolean;
  token?: string;
  grains?: string[];
  missing?: string[];
  source?: { kind: "local" | "s3"; [k: string]: unknown };
  /** Where per-session replay Parquet lives — local dir or `s3://…` prefix. */
  replayBase?: string;
  error?: string;
}

/**
 * A session id is about to be concatenated into SQL the host executes, so it is
 * checked rather than trusted. Ids come from our own corpus and are UUIDs; a
 * value that is not one is a bug or an attack, and both should stop here.
 */
export function replayFileSql(replayBase: string, sessionId: string): string {
  if (!/^[0-9a-fA-F-]{36}$/.test(sessionId)) {
    throw new Error(`refusing to build SQL for a non-UUID session id: ${sessionId}`);
  }
  return `'${replayBase}/${sessionId}.parquet'`;
}

/** Ask the dev server where (and whether) the DuckDB host is. */
export async function fetchHostInfo(): Promise<HostInfo> {
  try {
    const res = await fetch("/__duckdb-host", { cache: "no-store" });
    return (await res.json()) as HostInfo;
  } catch (e) {
    return { ok: false, error: `could not reach the dev server: ${(e as Error).message}` };
  }
}

/**
 * Same-origin Quack URI. The page never learns the host's port — `/quack` is
 * proxied by the dev-server plugin, which reads the port from the host's
 * runtime file per request.
 */
export function quackUri(): string {
  return `quack:${location.host}/quack`;
}

/**
 * `$aiui$…$aiui$` dollar quoting, not single quotes: Mosaic's generated SQL is
 * full of string literals, and any quote-escaping scheme that has to reason
 * about them will eventually meet one it mishandles. A dollar tag that cannot
 * occur in generated SQL side-steps the question entirely.
 */
function wrap(sql: string, uri: string, token: string): string {
  return `FROM quack_query('${uri}', $aiui$${sql}$aiui$, disable_ssl => true, token => '${token}')`;
}

interface QuackConnectorOptions {
  connection: unknown;
  uri: string;
  token: string;
}

/** A Mosaic connector that executes everything in the DuckDB host. */
export function quackConnector({ connection, uri, token }: QuackConnectorOptions): Connector {
  const inner = wasmConnector({ connection } as never) as Connector;
  // `Connector["query"]` is overloaded on request type (arrow / exec / json) and
  // the return type follows the argument. This wrapper is transparent to that —
  // it rewrites `sql` and changes nothing else — but TypeScript cannot express
  // "same overload set, one field replaced", so the identity is asserted once
  // here rather than smeared across three overload signatures.
  const query = ((req: ConnectorQueryRequest) =>
    inner.query({ ...req, sql: wrap(req.sql, uri, token) } as never)) as Connector["query"];
  return { query };
}
