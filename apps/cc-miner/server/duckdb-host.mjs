/**
 * duckdb-host.mjs — the DuckDB process that answers cc-miner's queries.
 *
 * cc-miner does not query Parquet in the tab any more. A native DuckDB here
 * holds the data and answers over Quack (DuckDB's own HTTP remote protocol);
 * the renderer's duckdb-wasm is reduced to a protocol client. Why: `ATTACH`-ing
 * a remote catalog performs NO pushdown — a bare `count(*)` over a 272 MB table
 * moved 5.26 GB — while `quack_query`, which sends the SQL as a string, answered
 * the same query in 5 ms with ~0 bytes. See docs/guide/duckdb-mosaic.md.
 *
 * It is deliberately NOT Electron-specific. `pnpm dev` (browser) needs it just
 * as much as `pnpm dev:electron` does, so it is a plain Node program that either
 * host can spawn.
 *
 * ── Ports ────────────────────────────────────────────────────────────────────
 * `quack_serve` rejects port 0, so there is no OS-assigned port to ask for. We
 * therefore pick a free one HERE (bind, read, release) and hand quack the
 * number — but the port is never the thing anyone looks up. Discovery is the
 * runtime file this writes, for the reason recorded in
 * docs/proposals/deployment-shapes.md §1.9: a hardcoded port does not fail
 * loudly when contended, it silently routes callers to whoever got there first.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DuckDBInstance } from "@duckdb/node-api";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(HERE, "..");

/** Where the host advertises itself. Read this; never assume a port. */
export const RUNTIME_FILE = resolve(APP_ROOT, ".aiui-cache/duckdb-host.json");

/** Extensions the host needs. `quack` serves; `httpfs`+`aws` reach S3. */
const EXTENSIONS = ["quack", "httpfs", "aws"];

/** Ask the OS for a free port, then release it for quack to claim. */
function freePort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });
}

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

/**
 * The grains the normaliser writes. Kept in step with cc-assay; a grain whose
 * files are absent simply yields an empty view rather than failing the boot.
 */
const GRAINS = [
  "turns",
  "toolCalls",
  "events",
  "sessions",
  "images",
  "forkEdges",
  "agentRuns",
  "lineages",
];

/**
 * The partition layout, in one place. `username` and `host` are partition KEYS,
 * not columns — the corpus is multi-machine from day one, so a read has to be
 * able to say "everyone" or "just me" without two code paths.
 */
export const LAYOUT_GLOB = "/username=*/host=*/**/*.parquet";

/** Legacy flat layout: `<dir>/<grain>.parquet`, what src/data holds today. */
const FLAT_GLOB = ".parquet";

async function main() {
  const dataDir = resolve(APP_ROOT, arg("data", "src/data"));
  const s3Profile = arg("s3-profile", null);
  const s3Prefix = arg("s3-prefix", null);
  const flat = process.argv.includes("--flat");

  const instance = await DuckDBInstance.create(":memory:");
  const conn = await instance.connect();

  for (const ext of EXTENSIONS) {
    // INSTALL reaches extensions.duckdb.org on first run. A packaged build sets
    // extension_directory to the bundled copies and skips this (verified: with
    // autoinstall/autoload off, LOAD alone works from a bundled directory).
    await conn.run(`INSTALL ${ext}`).catch(() => {});
    await conn.run(`LOAD ${ext}`);
  }

  if (s3Profile) {
    // One statement is the entire AWS integration — no SDK, no credential
    // plumbing. `credential_chain` honours SSO profiles, so an expired session
    // surfaces here as a clear error rather than a cryptic S3 failure later.
    await conn.run(
      `CREATE OR REPLACE SECRET cc_s3 (TYPE s3, PROVIDER credential_chain, PROFILE '${s3Profile}')`,
    );
  }

  const base = s3Prefix ?? dataDir;
  const failures = [];
  for (const grain of GRAINS) {
    const src = flat ? `${base}/${grain}${FLAT_GLOB}` : `${base}/${grain}${LAYOUT_GLOB}`;
    const sql =
      `CREATE OR REPLACE VIEW "${grain}" AS SELECT * FROM ` +
      `read_parquet('${src}', hive_partitioning=true, union_by_name=true)`;
    try {
      await conn.run(sql);
    } catch (e) {
      // A missing grain is normal — the normaliser grew some of these late, and
      // a checkout with older data should still boot. Record, do not fail.
      failures.push({ grain, err: String(e?.message ?? e).split("\n")[0] });
    }
  }

  const port = await freePort();
  const token = randomBytes(24).toString("hex");
  const served = await conn.runAndReadAll(
    `SELECT * FROM quack_serve('quack:127.0.0.1:${port}', token => '${token}', disable_ssl => true)`,
  );
  const row = served.getRowObjects()[0];

  mkdirSync(dirname(RUNTIME_FILE), { recursive: true });
  const runtime = {
    port,
    token,
    pid: process.pid,
    url: String(row.listen_url),
    source: s3Prefix
      ? { kind: "s3", prefix: s3Prefix, profile: s3Profile }
      : { kind: "local", dataDir },
    // Where per-session replay Parquet lives. The page cannot know this — the
    // base differs between a local checkout and an S3 prefix — so the host
    // advertises it and the page appends `<sessionId>.parquet`.
    replayBase: `${base}/replay`,
    grains: GRAINS.filter((g) => !failures.some((f) => f.grain === g)),
    missing: failures.map((f) => f.grain),
    startedAt: new Date().toISOString(),
  };
  writeFileSync(RUNTIME_FILE, `${JSON.stringify(runtime, null, 2)}\n`);

  console.log(`[duckdb-host] quack on ${row.listen_url}`);
  console.log(`[duckdb-host] source: ${runtime.source.kind} ${base}`);
  console.log(`[duckdb-host] grains: ${runtime.grains.join(", ") || "(none)"}`);
  if (failures.length) console.log(`[duckdb-host] absent: ${runtime.missing.join(", ")}`);
  console.log(`[duckdb-host] runtime: ${RUNTIME_FILE}`);

  const bye = () => {
    rmSync(RUNTIME_FILE, { force: true });
    process.exit(0);
  };
  process.on("SIGINT", bye);
  process.on("SIGTERM", bye);
  process.on("exit", () => rmSync(RUNTIME_FILE, { force: true }));
  setInterval(() => {}, 1 << 30);
}

main().catch((e) => {
  console.error("[duckdb-host] failed:", e?.message ?? e);
  process.exit(1);
});
