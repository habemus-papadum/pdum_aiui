#!/usr/bin/env node
/**
 * `cc-normalize` — scan Claude Code transcripts, write the five Parquet tables.
 *
 *   pnpm -C demos/transcript normalize                    # → ./out
 *   pnpm -C demos/transcript normalize -- --out ../ledger/src/data
 *   pnpm -C demos/transcript normalize -- --offline --no-images
 *
 * Prints the measurements that justify the pipeline (how wrong a naive reader
 * would be) and runs `checkInvariants` every time — a silent regression in the
 * dedup path is exactly the failure this tool exists to prevent.
 */

import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { writeParquet } from "./parquet.ts";
import { loadPriceTable, normalizeCorpus } from "./run.ts";
import { defaultRoots } from "./scan.ts";

interface Args {
  out: string;
  roots?: string[];
  offline: boolean;
  images: boolean;
  idleGapSeconds: number;
  quiet: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    out: path.join(process.cwd(), "out"),
    offline: false,
    images: true,
    idleGapSeconds: 1800,
    quiet: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--out") a.out = path.resolve(argv[++i]);
    else if (k === "--root") {
      a.roots ??= [];
      a.roots.push(path.resolve(argv[++i]));
    } else if (k === "--offline") a.offline = true;
    else if (k === "--no-images") a.images = false;
    else if (k === "--idle-gap") a.idleGapSeconds = Number(argv[++i]);
    else if (k === "--quiet") a.quiet = true;
    else if (k === "--help" || k === "-h") {
      process.stdout.write(
        "usage: cc-normalize [--out dir] [--root dir]... [--offline] [--no-images]\n" +
          "                   [--idle-gap seconds] [--quiet]\n",
      );
      process.exit(0);
    }
  }
  return a;
}

const args = parseArgs(process.argv.slice(2));
const log = (s: string) => {
  if (!args.quiet) process.stderr.write(`${s}\n`);
};
const fmt = (n: number) => n.toLocaleString("en-US");
const usd = (n: number) => `$${n.toFixed(2)}`;
const pctMore = (a: number, b: number) => `${((a / b - 1) * 100).toFixed(1)}%`;

const t0 = Date.now();
const cacheFile = path.join(import.meta.dirname, "..", ".cache", "litellm-pricing.json");
const pricing = await loadPriceTable(cacheFile, { offline: args.offline });
log(`pricing: ${Object.keys(pricing.entries).length} models @ ${pricing.version}`);

const roots = args.roots ?? defaultRoots();
log(`roots:   ${roots.join(", ")}`);

const { normalized, invariants, stats } = await normalizeCorpus({
  roots,
  pricing,
  idleGapSeconds: args.idleGapSeconds,
  skipImages: !args.images,
  onProgress: (files, records) => {
    if (files % 50 === 0) log(`  …${files} files, ${fmt(records)} records`);
  },
});

const written = await writeParquet(args.out, normalized, { mkdir, stat }, path.join);

// A manifest beside the Parquet: what produced these numbers, and when. The
// demo reads it to label its own figures honestly.
const manifest = {
  $schema: "aiui/cc-usage-manifest@1",
  generatedAt: new Date().toISOString(),
  roots,
  pricing: { source: pricing.source, version: pricing.version },
  tables: written,
  stats,
  invariants,
};
await writeFile(path.join(args.out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

if (!args.quiet) {
  process.stderr.write(`
CORPUS
  files                       ${fmt(stats.files)}  (${(stats.bytes / 1e6).toFixed(0)} MB)
  records                     ${fmt(stats.records)}   parse errors ${stats.parseErrors}
  assistant records           ${fmt(stats.assistantRecords)}
  deduped turns               ${fmt(stats.dedupedTurns)}   (${(stats.assistantRecords / Math.max(1, stats.dedupedTurns)).toFixed(2)}x records per response)

DEDUP EARNED ITS KEEP
  naive output-token sum      ${fmt(stats.naiveOutputTokens)}
  deduped                     ${fmt(stats.dedupedOutputTokens)}
  naive overstates by         ${pctMore(stats.naiveOutputTokens, Math.max(1, stats.dedupedOutputTokens))}
  message.ids in >1 file      ${fmt(stats.crossFileDuplicates)}   (fork/resume copies)
  records marked inherited    ${fmt(stats.inheritedTurnsSeen)}   (session_id != sessionId)

TABLES → ${args.out}
${Object.entries(written)
  .map(
    ([k, v]) =>
      `  ${k.padEnd(12)} ${String(fmt(v.rows)).padStart(8)} rows  ${(v.bytes / 1024).toFixed(0)} KB`,
  )
  .join("\n")}

DERIVED COST                  ${usd(stats.totalCost)}   (${pricing.source} @ ${pricing.version})
  unpriced turns              ${stats.unpricedTurns}
  turns without a timestamp   ${stats.turnsWithoutTimestamp}

INVARIANTS                    ${invariants.ok ? "ok" : "FAILED"}
${invariants.problems.map((p) => `  ✗ ${p}`).join("\n")}

${((Date.now() - t0) / 1000).toFixed(1)}s
`);
}

process.exit(invariants.ok ? 0 : 1);
