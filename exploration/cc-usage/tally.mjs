#!/usr/bin/env node
/**
 * tally.mjs — proves the claims in `fields.mjs` against the live corpus.
 *
 * Not a product: a measurement harness. It answers "how wrong would a naive
 * reader be?" in real numbers, so PROPOSAL.md can quote them and a future run
 * can check whether they still hold.
 *
 *   node tally.mjs [--root <dir>]
 */

import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import {
  billableUnits,
  billingKey,
  compaction,
  get,
  isWasted,
  messageId,
  num,
  preferOriginal,
  splitModel,
  str,
  toolOutcome,
  toolUses,
  UNPRICED_MODELS,
} from "./fields.mjs";

const root = process.argv.includes("--root")
  ? process.argv[process.argv.indexOf("--root") + 1]
  : path.join(homedir(), ".claude", "projects");

async function* files(dir, project = null, rel = []) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* files(full, project ?? e.name, project ? [...rel, e.name] : []);
    else if (e.name.endsWith(".jsonl")) yield { file: full, project, nested: rel.length > 0 };
  }
}

const S = {
  assistantRecords: 0,
  distinctBillingKeys: new Set(),
  distinctMessageIds: new Set(),
  naiveOutput: 0,
  naiveCacheRead: 0,
  nestedAssistantRecords: 0,
  fallbackRecords: 0,
  fallbackWastedOutput: 0,
  wastedRecords: 0,
  compactions: 0,
  compactPre: 0,
  compactPost: 0,
  compactDropped: 0,
  toolCalls: new Map(),
  toolFailures: new Map(),
  modelsUnpriced: 0,
  variantModels: new Map(),
  sessionIdMismatch: 0,
};
/** billingKey -> the chosen record's billable units */
const billed = new Map();

for await (const { file, nested } of files(root)) {
  const fileSession = path.basename(file, ".jsonl");
  const rl = createInterface({ input: createReadStream(file, "utf8"), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    if (r?.type === "system") {
      const c = compaction(r);
      if (c) {
        S.compactions++;
        S.compactPre += c.preTokens;
        S.compactPost += c.postTokens;
        S.compactDropped = Math.max(S.compactDropped, c.droppedCumulative);
      }
      continue;
    }
    if (r?.type === "user") {
      const o = toolOutcome(r);
      if (o?.ok === false || o?.error) {
        for (const t of ["<unknown>"]) bumpMap(S.toolFailures, t);
      }
      continue;
    }
    if (r?.type !== "assistant") continue;

    S.assistantRecords++;
    if (nested) S.nestedAssistantRecords++;
    const mid = messageId(r);
    if (mid) S.distinctMessageIds.add(mid);
    const bk = billingKey(r);
    if (bk) S.distinctBillingKeys.add(bk);

    // naive: sum every record
    S.naiveOutput += num(get(r, "message.usage.output_tokens"));
    S.naiveCacheRead += num(get(r, "message.usage.cache_read_input_tokens"));

    // correct: dedup, then price over iterations
    if (bk) {
      const prev = billed.get(bk);
      billed.set(bk, prev ? { rec: preferOriginal(prev.rec, r) } : { rec: r });
    }

    for (const t of toolUses(r)) bumpMap(S.toolCalls, t.name ?? "<unnamed>");
    if (isWasted(r)) S.wastedRecords++;
    const m = str(get(r, "message.model"));
    if (m && UNPRICED_MODELS.has(m)) S.modelsUnpriced++;
    const { variant } = splitModel(m);
    if (variant) bumpMap(S.variantModels, m);
    const rsid = str(r.sessionId);
    if (rsid && !nested && rsid !== fileSession) S.sessionIdMismatch++;
  }
}

// second pass over the deduped set
const dedup = { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, cache5m: 0, cache1h: 0 };
const perModel = new Map();
for (const { rec } of billed.values()) {
  const units = billableUnits(rec);
  const hasFallback = units.some((u) => u.iterationType === "fallback_message");
  if (hasFallback) {
    S.fallbackRecords++;
    for (const u of units)
      if (u.iterationType !== "fallback_message") S.fallbackWastedOutput += u.output;
  }
  for (const u of units) {
    if (!u.model || UNPRICED_MODELS.has(u.model)) continue;
    dedup.input += u.input;
    dedup.output += u.output;
    dedup.cacheCreate += u.cacheCreate;
    dedup.cacheRead += u.cacheRead;
    dedup.cache5m += u.cache5m;
    dedup.cache1h += u.cache1h;
    const pm = perModel.get(u.model) ?? { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, n: 0 };
    pm.input += u.input;
    pm.output += u.output;
    pm.cacheCreate += u.cacheCreate;
    pm.cacheRead += u.cacheRead;
    pm.n++;
    perModel.set(u.model, pm);
  }
}

function bumpMap(m, k) {
  m.set(k, (m.get(k) ?? 0) + 1);
}
const fmt = (n) => n.toLocaleString("en-US");
const pct = (a, b) => `${((a / b - 1) * 100).toFixed(1)}%`;

console.log(`
CORPUS
  assistant records           ${fmt(S.assistantRecords)}
    …of which in subagent/wf   ${fmt(S.nestedAssistantRecords)}  (${((S.nestedAssistantRecords / S.assistantRecords) * 100).toFixed(1)}% — invisible to a flat glob)
  distinct message.id          ${fmt(S.distinctMessageIds.size)}
  distinct (message.id,reqId)  ${fmt(S.distinctBillingKeys.size)}
  records per API response     ${(S.assistantRecords / S.distinctMessageIds.size).toFixed(2)}x

TRAP 1 — per-block duplication (output tokens)
  naive sum over records      ${fmt(S.naiveOutput)}
  deduped + iteration-aware   ${fmt(dedup.output)}
  naive overstates by         ${pct(S.naiveOutput, dedup.output)}

TRAP 1 — same, cache_read (the dominant token class)
  naive sum over records      ${fmt(S.naiveCacheRead)}
  deduped                     ${fmt(dedup.cacheRead)}
  naive overstates by         ${pct(S.naiveCacheRead, dedup.cacheRead)}

TRAP 3 — model fallback
  responses with a fallback   ${fmt(S.fallbackRecords)}
  output tokens billed for
  the DISCARDED attempt       ${fmt(S.fallbackWastedOutput)}  (invisible in top-level usage)

DEDUPED TOKEN TOTALS
  input                       ${fmt(dedup.input)}
  output                      ${fmt(dedup.output)}
  cache creation              ${fmt(dedup.cacheCreate)}   (5m ${fmt(dedup.cache5m)} / 1h ${fmt(dedup.cache1h)})
  cache read                  ${fmt(dedup.cacheRead)}
  cache read : input ratio    ${(dedup.cacheRead / dedup.input).toFixed(0)}x

PER MODEL (deduped)
${[...perModel.entries()]
  .sort((a, b) => b[1].output - a[1].output)
  .map(
    ([m, v]) =>
      `  ${m.padEnd(28)} resp=${String(v.n).padStart(6)}  out=${String(fmt(v.output)).padStart(12)}  cacheRead=${fmt(v.cacheRead)}`,
  )
  .join("\n")}

OTHER SIGNALS
  compaction events           ${fmt(S.compactions)}  (pre→post avg ${fmt(Math.round(S.compactPre / Math.max(1, S.compactions)))} → ${fmt(Math.round(S.compactPost / Math.max(1, S.compactions)))} tokens)
  max cumulativeDroppedTokens ${fmt(S.compactDropped)}
  aborted / api-error records ${fmt(S.wastedRecords)}
  "<synthetic>" records       ${fmt(S.modelsUnpriced)}
  bracketed model variants    ${[...S.variantModels.entries()].map(([k, v]) => `${k}=${v}`).join(", ") || "none"}
  sessionId != filename       ${fmt(S.sessionIdMismatch)}

TOP TOOLS
${[...S.toolCalls.entries()]
  .sort((a, b) => b[1] - a[1])
  .slice(0, 12)
  .map(([k, v]) => `  ${k.padEnd(28)} ${fmt(v)}`)
  .join("\n")}
`);

// --- derived cost ----------------------------------------------------------
// Separate section, separate caveat: none of this is in the transcript.

const { loadPricing, priceUnit } = await import("./pricing.mjs");
const pricing = await loadPricing(
  path.join(import.meta.dirname, "snapshots", "litellm-pricing.json"),
  {
    offline: process.argv.includes("--offline"),
  },
).catch((e) => {
  console.error(`(no pricing: ${e.message})`);
  return null;
});

if (pricing) {
  const costByModel = new Map();
  const costByClass = { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 };
  let unpriced = 0;
  for (const { rec } of billed.values()) {
    for (const u of billableUnits(rec)) {
      if (!u.model || UNPRICED_MODELS.has(u.model)) continue;
      const p = priceUnit(pricing.table, u);
      if (!p) {
        unpriced++;
        continue;
      }
      costByClass.input += p.input;
      costByClass.output += p.output;
      costByClass.cacheCreate += p.cacheCreate;
      costByClass.cacheRead += p.cacheRead;
      costByModel.set(u.model, (costByModel.get(u.model) ?? 0) + p.total);
    }
  }
  const total = Object.values(costByClass).reduce((a, b) => a + b, 0);
  const usd = (x) => `$${x.toFixed(2)}`;
  console.log(`DERIVED COST  (LiteLLM table @ ${pricing.version}; NOT from the transcript)
  input                       ${usd(costByClass.input).padStart(10)}   ${((costByClass.input / total) * 100).toFixed(1)}%
  output                      ${usd(costByClass.output).padStart(10)}   ${((costByClass.output / total) * 100).toFixed(1)}%
  cache creation              ${usd(costByClass.cacheCreate).padStart(10)}   ${((costByClass.cacheCreate / total) * 100).toFixed(1)}%
  cache read                  ${usd(costByClass.cacheRead).padStart(10)}   ${((costByClass.cacheRead / total) * 100).toFixed(1)}%
  ${"─".repeat(46)}
  TOTAL                       ${usd(total).padStart(10)}
  unpriced units              ${unpriced}

  by model
${[...costByModel.entries()]
  .sort((a, b) => b[1] - a[1])
  .map(([m, v]) => `    ${m.padEnd(28)} ${usd(v).padStart(10)}`)
  .join("\n")}
`);
}
