/**
 * export-cli.ts — write a mined corpus into the layout, locally or to S3.
 *
 *   pnpm export --from <dir-of-grains> --to <dir|s3://bucket/prefix> [--s3-profile <p>]
 *
 * The layout and the reasoning behind it are LAYOUT.md; the SQL is export.ts.
 * This file is only argument handling, iteration, and the index.
 */
import { cpSync, existsSync, globSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import {
  attachS3,
  buildIndex,
  exportGrainSql,
  GRAINS,
  resolveHostIdentity,
  type ShardEntry,
} from "./export";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main(): Promise<void> {
  const from = arg("from");
  const to = arg("to");
  const s3Profile = arg("s3-profile");
  if (!from || !to) {
    console.error(
      "usage: export --from <dir-of-grains> --to <dir|s3://bucket/prefix> [--s3-profile <p>]",
    );
    process.exit(2);
  }
  const isS3 = to.startsWith("s3://");
  if (isS3 && !s3Profile) {
    console.error("--to is an s3:// prefix, so --s3-profile is required");
    process.exit(2);
  }

  const { username, hostId, hostname } = await resolveHostIdentity(from, arg("username"));
  const conn = await (await DuckDBInstance.create(":memory:")).connect();
  if (s3Profile) await attachS3(conn, s3Profile);
  if (!isS3) mkdirSync(to, { recursive: true });

  const opts = {
    prefix: to,
    username,
    hostId,
    sourceSql: (g: string) => `read_parquet('${path.resolve(from, `${g}.parquet`)}')`,
  };

  const shards: ShardEntry[] = [];
  for (const grain of GRAINS) {
    if (!existsSync(path.resolve(from, `${grain.name}.parquet`))) {
      console.log(`  – ${grain.name}: absent from the source, skipped`);
      continue;
    }
    await conn.run(exportGrainSql(grain, opts));
    if (isS3) {
      // No cheap local stat for an S3 prefix; the index records rows only, and
      // a later `--reindex` against the bucket can fill in sizes.
      console.log(`  ✓ ${grain.name} → ${to}/${grain.name}`);
      continue;
    }
    for (const file of globSync(`${to}/${grain.name}/**/*.parquet`)) {
      const rel = path.relative(to, file);
      const rows = Number(
        (
          await conn.runAndReadAll(`SELECT count(*) AS n FROM read_parquet('${file}')`)
        ).getRowObjects()[0]?.n ?? 0,
      );
      const month = rel.match(/month=([0-9]{4}-[0-9]{2})/)?.[1];
      shards.push({
        grain: grain.name,
        username,
        host: hostId,
        ...(month ? { month } : {}),
        path: rel,
        bytes: statSync(file).size,
        rows,
      });
    }
    console.log(`  ✓ ${grain.name}`);
  }

  // Replay is per-session and read by path, not globbed as a grain — it travels
  // beside the partitions rather than inside them.
  const replaySrc = path.resolve(from, "replay");
  if (!isS3 && existsSync(replaySrc)) {
    cpSync(replaySrc, path.join(to, "replay"), { recursive: true });
    console.log("  ✓ replay/");
  }
  const manifest = path.resolve(from, "manifest.json");
  if (!isS3 && existsSync(manifest)) cpSync(manifest, path.join(to, "manifest.json"));

  if (!isS3) {
    const index = buildIndex(shards, { users: [username], hosts: { [hostId]: hostname } });
    writeFileSync(path.join(to, "index.json"), `${JSON.stringify(index, null, 2)}\n`);
    const mb = (index.totals.bytes / 1e6).toFixed(2);
    console.log(`\n  ${shards.length} shards, ${mb} MB, ${index.totals.rows} rows → ${to}`);
  }
}

main().catch((e) => {
  const msg = String(e?.message ?? e);
  // SSO sessions expire; say what to do rather than surfacing an S3 403.
  if (/expired|token|credential|sso/i.test(msg)) {
    console.error(`\nAWS credentials look stale — try: aws sso login --profile <your-profile>\n`);
  }
  console.error(msg);
  process.exit(1);
});
