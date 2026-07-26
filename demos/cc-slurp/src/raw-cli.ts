#!/usr/bin/env node
/**
 * `cc-slurp raw` — stage 1. Ingest this machine's transcripts into a per-host
 * raw Parquet set.
 *
 *   pnpm -C demos/cc-slurp raw -- --out ~/.cache/aiui/cc-raw
 *
 * The output directory is one host's artifact: `raw.parquet`, `files.parquet`
 * and `host.json`. It is meant to travel — copy several hosts' directories
 * together and stage 2 merges them.
 */

import { mkdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { resolveHost } from "./host.ts";
import { ingestRoot } from "./raw.ts";
import { writeRaw } from "./raw-parquet.ts";
import { defaultRoots } from "./scan.ts";

const argv = process.argv.slice(2);
const arg = (k: string, d?: string) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : d;
};
const out = path.resolve(arg("--out") ?? path.join(homedir(), ".cache", "aiui", "cc-raw", "local"));
const roots = argv.includes("--root")
  ? argv.filter((_, i) => argv[i - 1] === "--root").map((p) => path.resolve(p))
  : defaultRoots();
const quiet = argv.includes("--quiet");

const t0 = Date.now();
await mkdir(out, { recursive: true });
const host = await resolveHost(out);
if (!quiet) {
  process.stderr.write(`host:  ${host.hostname} (${host.hostId.slice(0, 8)}) ${host.platform}\n`);
  process.stderr.write(`roots: ${roots.join(", ")}\n`);
}

const all = { raw: [] as never[], files: [] as never[] };
const stats = { files: 0, jsonlFiles: 0, sidecarFiles: 0, lines: 0, parseErrors: 0, bytes: 0 };
for (const root of roots) {
  const r = await ingestRoot(root, host);
  // NOT push(...arr) — the raw layer has ~160k rows and spreading that many
  // arguments overflows the call stack.
  for (const row of r.raw) all.raw.push(row as never);
  for (const row of r.files) all.files.push(row as never);
  for (const k of Object.keys(stats) as (keyof typeof stats)[]) stats[k] += r.stats[k];
}

writeRaw(out, all.raw, all.files, path.join);
const size = async (n: string) => (await stat(path.join(out, n))).size;
const manifest = {
  $schema: "aiui/cc-raw-manifest@1",
  generatedAt: new Date().toISOString(),
  host,
  roots,
  stats,
  tables: {
    raw: { rows: all.raw.length, bytes: await size("raw.parquet") },
    files: { rows: all.files.length, bytes: await size("files.parquet") },
  },
};
await writeFile(path.join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

if (!quiet) {
  const mb = (b: number) => `${(b / 1e6).toFixed(1)} MB`;
  const f = (n: number) => n.toLocaleString("en-US");
  process.stderr.write(`
RAW INGEST -> ${out}
  files scanned         ${f(stats.files)}   (${f(stats.jsonlFiles)} jsonl, ${f(stats.sidecarFiles)} sidecar)
  lines                 ${f(stats.lines)}   parse errors ${stats.parseErrors}
  source bytes          ${mb(stats.bytes)}

  raw.parquet           ${f(all.raw.length)} rows   ${mb(manifest.tables.raw.bytes)}
  files.parquet         ${f(all.files.length)} rows   ${mb(manifest.tables.files.bytes)}
  compression           ${((manifest.tables.raw.bytes / Math.max(1, stats.bytes)) * 100).toFixed(0)}% of source

${((Date.now() - t0) / 1000).toFixed(1)}s
`);
}
