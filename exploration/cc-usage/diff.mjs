#!/usr/bin/env node
/**
 * diff.mjs — schema drift detection between two census snapshots.
 *
 * This is the re-runnable half of the workflow. Every few weeks:
 *
 *   node census.mjs --out snapshots/$(date +%Y-%m-%d).json
 *   node diff.mjs snapshots/<previous>.json snapshots/<new>.json
 *
 * It reports, in severity order:
 *
 *   BREAKING  a path we depend on vanished, or changed JSON type
 *   NEW       a record shape or field that did not exist before  ← the interesting one
 *   WIDENED   a categorical field grew a new member (new model, new stop_reason…)
 *   GONE      a field disappeared (may just be absent from this corpus slice)
 *
 * Exit code is 1 when anything BREAKING is found, so this can gate CI.
 *
 * `--watch <path,path>` marks paths as load-bearing: their disappearance or
 * type change is BREAKING rather than merely GONE. Defaults to the billing
 * surface, because that is what silently corrupts numbers rather than crashing.
 */

import { readFile } from "node:fs/promises";

const DEFAULT_WATCH = [
  "message.id",
  "message.model",
  "message.usage.input_tokens",
  "message.usage.output_tokens",
  "message.usage.cache_creation_input_tokens",
  "message.usage.cache_read_input_tokens",
  "message.usage.iterations[].type",
  "message.usage.iterations[].output_tokens",
  "timestamp",
  "sessionId",
  "cwd",
  "requestId",
  "uuid",
  "parentUuid",
];

const argv = process.argv.slice(2);
const files = argv.filter((a) => !a.startsWith("--"));
if (files.length !== 2) {
  console.error(
    "usage: node diff.mjs <old-snapshot.json> <new-snapshot.json> [--watch a,b] [--json]",
  );
  process.exit(2);
}
const watchArg = argv.indexOf("--watch");
const watch = new Set(watchArg >= 0 ? argv[watchArg + 1].split(",") : DEFAULT_WATCH);
const asJson = argv.includes("--json");

const [oldSnap, newSnap] = await Promise.all(
  files.map(async (f) => JSON.parse(await readFile(f, "utf8"))),
);

const findings = [];
const add = (level, kind, where, detail) => findings.push({ level, kind, where, detail });

// --- corpus-level movement -------------------------------------------------

const ov = Object.keys(oldSnap.corpus.ccVersions ?? {});
const nv = Object.keys(newSnap.corpus.ccVersions ?? {});
const newVersions = nv.filter((v) => !ov.includes(v)).sort(cmpVersion);
if (newVersions.length) {
  add(
    "INFO",
    "cc-versions",
    "corpus",
    `new Claude Code builds observed: ${newVersions.join(", ")}`,
  );
}
for (const key of ["models", "tools"]) {
  const before = new Set(Object.keys(oldSnap.corpus[key] ?? {}));
  const after = Object.keys(newSnap.corpus[key] ?? {});
  const fresh = after.filter((k) => !before.has(k));
  if (fresh.length) add("NEW", key, "corpus", fresh.join(", "));
}
for (const kind of Object.keys(newSnap.corpus.fileKinds ?? {})) {
  if (!(kind in (oldSnap.corpus.fileKinds ?? {}))) {
    add("NEW", "file-kind", "corpus", `a new on-disk file shape appeared: "${kind}"`);
  }
}

// --- shapes ----------------------------------------------------------------

const oldShapes = oldSnap.shapes ?? {};
const newShapes = newSnap.shapes ?? {};

for (const key of Object.keys(newShapes)) {
  if (!(key in oldShapes)) {
    add(
      "NEW",
      "record-shape",
      key,
      `${newShapes[key].count} records; ${Object.keys(newShapes[key].paths).length} fields`,
    );
  }
}
for (const key of Object.keys(oldShapes)) {
  if (!(key in newShapes)) add("GONE", "record-shape", key, `was ${oldShapes[key].count} records`);
}

for (const key of Object.keys(newShapes)) {
  const before = oldShapes[key];
  if (!before) continue;
  const after = newShapes[key];

  for (const [p, np] of Object.entries(after.paths)) {
    const op = before.paths[p];
    if (!op) {
      // A brand-new field. Loud, because this is how we learn about features.
      add("NEW", "field", `${key} · ${p}`, describe(np));
      continue;
    }
    // type change
    const ot = op.types.filter((t) => t !== "null");
    const nt = np.types.filter((t) => t !== "null");
    const changed = ot.join(",") !== nt.join(",");
    if (changed) {
      const level = watch.has(p) ? "BREAKING" : "CHANGED";
      add(level, "type", `${key} · ${p}`, `${op.types.join("|")} → ${np.types.join("|")}`);
    }
    // categorical widening — a new enum member is a feature announcement
    if (op.categorical && np.categorical) {
      const known = new Set(op.categorical);
      const fresh = np.categorical.filter((v) => !known.has(v));
      const dropped = op.categorical.filter((v) => !np.categorical.includes(v));
      if (fresh.length) add("WIDENED", "enum", `${key} · ${p}`, `+ ${fresh.map(q).join(", ")}`);
      if (dropped.length)
        add("INFO", "enum", `${key} · ${p}`, `no longer seen: ${dropped.map(q).join(", ")}`);
    }
    // a categorical field that overflowed into free text is a real semantic change
    if (op.categorical && !np.categorical) {
      add(
        "CHANGED",
        "enum",
        `${key} · ${p}`,
        `was categorical (${op.categorical.length} values), now high-cardinality`,
      );
    }
    // presence collapse: field still exists but almost stopped appearing
    if (op.presence >= 0.5 && np.presence < op.presence * 0.5) {
      const level = watch.has(p) ? "BREAKING" : "CHANGED";
      add(
        level,
        "presence",
        `${key} · ${p}`,
        `presence ${fmtPct(op.presence)} → ${fmtPct(np.presence)}`,
      );
    }
  }

  for (const [p, op] of Object.entries(before.paths)) {
    if (p in after.paths) continue;
    const level = watch.has(p) ? "BREAKING" : "GONE";
    add(level, "field", `${key} · ${p}`, `was present on ${fmtPct(op.presence)} of ${key} records`);
  }
}

// --- tool surface ----------------------------------------------------------
// Reported separately from transcript schema: a tool gaining a parameter is a
// Claude Code feature announcement, but it is not a change to the log format.

const oldTools = oldSnap.toolSchemas ?? {};
const newTools = newSnap.toolSchemas ?? {};
for (const [name, t] of Object.entries(newTools)) {
  const before = oldTools[name];
  if (!before) {
    add(
      "NEW",
      "tool",
      name,
      `${t.calls} calls; params: ${Object.keys(t.params).join(", ") || "(none)"}`,
    );
    continue;
  }
  const fresh = Object.keys(t.params).filter((p) => !(p in before.params));
  if (fresh.length) add("NEW", "tool-param", name, fresh.join(", "));
}
for (const name of Object.keys(oldTools)) {
  if (!(name in newTools)) add("GONE", "tool", name, `was ${oldTools[name].calls} calls`);
}

// --- report ----------------------------------------------------------------

const ORDER = ["BREAKING", "NEW", "CHANGED", "WIDENED", "GONE", "INFO"];
findings.sort(
  (a, b) => ORDER.indexOf(a.level) - ORDER.indexOf(b.level) || a.where.localeCompare(b.where),
);

if (asJson) {
  console.log(
    JSON.stringify({ from: oldSnap.capturedAt, to: newSnap.capturedAt, findings }, null, 2),
  );
} else {
  console.log(`schema drift: ${oldSnap.capturedAt} → ${newSnap.capturedAt}`);
  console.log(
    `  corpus: ${oldSnap.corpus.records} → ${newSnap.corpus.records} records, ` +
      `${Object.keys(oldSnap.shapes).length} → ${Object.keys(newSnap.shapes).length} shapes\n`,
  );
  if (findings.length === 0) console.log("  no drift.");
  let last = null;
  for (const f of findings) {
    if (f.level !== last) {
      console.log(`\n── ${f.level} ${"─".repeat(Math.max(0, 60 - f.level.length))}`);
      last = f.level;
    }
    console.log(`  ${f.where}`);
    console.log(`      ${f.detail}`);
  }
  const counts = ORDER.map((l) => [l, findings.filter((f) => f.level === l).length]).filter(
    (e) => e[1],
  );
  console.log(`\n${counts.map(([l, n]) => `${l}=${n}`).join("  ")}`);
}

process.exit(findings.some((f) => f.level === "BREAKING") ? 1 : 0);

// --- helpers ---------------------------------------------------------------

function describe(p) {
  const bits = [`${p.types.join("|")}`, `${fmtPct(p.presence)} of records`];
  if (p.categorical) bits.push(`values: ${p.categorical.slice(0, 8).map(q).join(", ")}`);
  else if (p.examples?.length) bits.push(`e.g. ${q(p.examples[0])}`);
  if (p.numeric) bits.push(`range ${p.numeric.min}…${p.numeric.max}`);
  return bits.join(" · ");
}
function q(s) {
  return `"${String(s).slice(0, 48)}"`;
}
function fmtPct(n) {
  return `${(n * 100).toFixed(1)}%`;
}
function cmpVersion(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
}
