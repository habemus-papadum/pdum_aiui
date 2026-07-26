#!/usr/bin/env node
/**
 * census.mjs — a schema census of Claude Code's on-disk session logs.
 *
 * Streams every `~/.claude/projects/<slug>/<sessionId>.jsonl` line, walks each
 * record's full JSON tree, and records — per *shape key* — every leaf path it
 * has ever seen, the JS types at that path, how often it appeared, and (for
 * low-cardinality paths) the complete value set.
 *
 * The output (`schema-snapshot.json`) is deliberately deterministic and
 * value-bearing so that two snapshots taken weeks apart can be **diffed** to
 * surface Claude Code schema drift: new record types, new fields, fields that
 * changed type, categorical fields that grew a new member. See `diff.mjs`.
 *
 * Zero dependencies — plain node ESM, so this keeps running no matter what the
 * workspace does.
 *
 *   node census.mjs [--root <dir>] [--out <file>] [--max-lines N] [--quiet]
 */

import { createReadStream } from "node:fs";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

// ---------------------------------------------------------------------------
// tunables
// ---------------------------------------------------------------------------

/** A path with at most this many distinct values is reported as *categorical*. */
const CATEGORICAL_MAX = 40;
/** Longest string retained as a sample/enum member (keeps base64 images out). */
const SAMPLE_MAX_LEN = 120;
/** Per path, keep at most this many example values for non-categorical paths. */
const EXAMPLES_PER_PATH = 3;
/** Guard against pathological records (a 10 MB pasted image blows the walker). */
const MAX_NODES_PER_RECORD = 20_000;
/**
 * An object with more than this many keys is treated as a *dictionary* (a map
 * keyed by data — file paths, uuids) rather than a struct, and its keys collapse
 * to `{}`. Without this, `file-history-snapshot.snapshot.trackedFileBackups`
 * alone contributes ~8000 "fields" that are really one field shape.
 */
const DICT_MIN_KEYS = 12;
/**
 * Paths recorded but never descended into. A `tool_use` block's `input` is the
 * *tool's* schema, not Claude Code's — walking it turns every parameter of
 * every tool into a "schema field" and buries real drift under hundreds of
 * findings. Tool parameters get their own shallow census instead (`toolSchemas`).
 */
const OPAQUE_PATHS = new Set(["input", "answers", "newTodos", "oldTodos"]);

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {
    root: path.join(homedir(), ".claude", "projects"),
    out: path.join(process.cwd(), "snapshots", "schema-snapshot.json"),
    maxLines: Infinity,
    quiet: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--root") out.root = argv[++i];
    else if (a === "--out") out.out = argv[++i];
    else if (a === "--max-lines") out.maxLines = Number(argv[++i]);
    else if (a === "--quiet") out.quiet = true;
    else if (a === "--help" || a === "-h") {
      console.log("usage: node census.mjs [--root dir] [--out file] [--max-lines N] [--quiet]");
      process.exit(0);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// shape keys — the discriminants that actually partition this schema
// ---------------------------------------------------------------------------

/**
 * Claude Code's transcript is a tagged union on `type`, but the two types that
 * carry the payload (`user`, `assistant`) are themselves unions: the Anthropic
 * message inside them has `content` blocks that are their own tagged union.
 * So the census partitions on three levels, and each gets its own namespace:
 *
 *   record:<type>                    — the envelope
 *   content:<record type>:<block type> — a content block inside message.content[]
 *   toolResult:<record type>         — the structured `toolUseResult` sidecar
 */
function shapeKeyForRecord(rec) {
  const t = typeof rec?.type === "string" ? rec.type : "<missing>";
  if (t === "user" || t === "assistant") {
    // sub-shard the two big ones so sidechain/meta variants stay visible
    const marks = [];
    if (rec.isSidechain === true) marks.push("sidechain");
    if (rec.isMeta === true) marks.push("meta");
    if (rec.isCompactSummary === true) marks.push("compactSummary");
    if (rec.isApiErrorMessage === true) marks.push("apiError");
    if (marks.length) return `record:${t}[${marks.join("+")}]`;
  }
  return `record:${t}`;
}

// ---------------------------------------------------------------------------
// the census accumulator
// ---------------------------------------------------------------------------

class Census {
  constructor() {
    /** shapeKey -> { count, paths: Map<path, PathStat> } */
    this.shapes = new Map();
    this.records = 0;
    this.parseErrors = 0;
    this.files = 0;
    this.bytes = 0;
    /** ISO timestamp bounds seen anywhere. */
    this.minTs = null;
    this.maxTs = null;
    /** cross-cutting tallies that are cheaper to collect here than to re-derive */
    this.toolNames = new Map();
    this.models = new Map();
    this.projects = new Map();
    this.versions = new Map();
    /** paths that were collapsed as data-keyed dictionaries */
    this.dicts = new Set();
    /** file-shape tally: flat session vs nested subagent vs workflow journal */
    this.fileKinds = new Map();
    /** toolName -> { calls, params: Map<param, {count, types:Set}> } — kept out
     *  of `shapes` so tool parameters never drown out transcript-schema drift. */
    this.toolSchemas = new Map();
  }

  noteToolCall(name, input) {
    let t = this.toolSchemas.get(name);
    if (!t) {
      t = { calls: 0, params: new Map() };
      this.toolSchemas.set(name, t);
    }
    t.calls++;
    if (!input || typeof input !== "object" || Array.isArray(input)) return;
    for (const [k, v] of Object.entries(input)) {
      let p = t.params.get(k);
      if (!p) {
        p = { count: 0, types: new Set() };
        t.params.set(k, p);
      }
      p.count++;
      p.types.add(jsonType(v));
    }
  }

  shape(key) {
    let s = this.shapes.get(key);
    if (!s) {
      s = { count: 0, paths: new Map(), fileKinds: new Map() };
      this.shapes.set(key, s);
    }
    return s;
  }

  /** Record one leaf/branch observation. */
  note(shape, p, value) {
    let st = shape.paths.get(p);
    if (!st) {
      st = {
        count: 0,
        types: new Set(),
        /** distinct scalar values, capped; null once it overflows CATEGORICAL_MAX */
        values: new Set(),
        overflowed: false,
        examples: [],
        nullCount: 0,
        // numeric summary, for token/cost fields
        num: null,
      };
      shape.paths.set(p, st);
    }
    st.count++;

    const t = jsonType(value);
    st.types.add(t);

    if (t === "null") {
      st.nullCount++;
      return;
    }
    if (t === "object" || t === "array") return;

    if (t === "number") {
      st.num ??= { min: Infinity, max: -Infinity, sum: 0, n: 0 };
      st.num.min = Math.min(st.num.min, value);
      st.num.max = Math.max(st.num.max, value);
      st.num.sum += value;
      st.num.n++;
    }

    const s = t === "string" ? value : String(value);
    if (s.length <= SAMPLE_MAX_LEN) {
      if (!st.overflowed) {
        st.values.add(s);
        if (st.values.size > CATEGORICAL_MAX) {
          st.overflowed = true;
          st.values.clear();
        }
      }
      if (st.examples.length < EXAMPLES_PER_PATH && !st.examples.includes(s)) {
        st.examples.push(s);
      }
    } else {
      // long string: never a category, but keep a shape hint
      st.overflowed = true;
      st.values.clear();
      if (st.examples.length < EXAMPLES_PER_PATH) {
        st.examples.push(`${s.slice(0, SAMPLE_MAX_LEN)}… (len ${s.length})`);
      }
    }
  }

  /** Walk a record, emitting normalized paths. Array indices collapse to `[]`. */
  walk(shape, node, prefix, budget) {
    if (budget.n++ > MAX_NODES_PER_RECORD) return;
    const t = jsonType(node);
    if (t === "object") {
      // record the container itself so "field exists but is an object" is visible
      if (prefix) this.note(shape, prefix, node);
      // Opaque by leaf name, so `input` and `toolUseResult.answers` both hit.
      if (OPAQUE_PATHS.has(prefix.split(".").pop())) return;
      const keys = Object.keys(node);
      // Data-keyed map (file paths, uuids) → collapse to one `{}` slot, else the
      // census would report every key in the user's repo as a schema field.
      if (looksLikeDict(keys)) {
        this.dicts.add(prefix);
        for (const k of keys.slice(0, 3)) this.walk(shape, node[k], `${prefix}{}`, budget);
        return;
      }
      for (const k of keys) {
        const p = prefix ? `${prefix}.${k}` : k;
        this.walk(shape, node[k], p, budget);
      }
    } else if (t === "array") {
      if (prefix) this.note(shape, prefix, node);
      // Sample the array: first 3 + last 1 keeps union members visible without
      // walking a 5000-element content array element by element.
      const idxs = node.length <= 4 ? node.keys() : [0, 1, 2, node.length - 1];
      for (const i of idxs) this.walk(shape, node[i], `${prefix}[]`, budget);
    } else {
      this.note(shape, prefix, node);
    }
  }

  add(rec, project, kind) {
    this.records++;
    const key = shapeKeyForRecord(rec);
    const shape = this.shape(key);
    shape.count++;
    bump(shape.fileKinds, kind);
    this.walk(shape, rec, "", { n: 0 });

    // cross-cutting tallies
    const ts = rec.timestamp;
    if (typeof ts === "string") {
      if (this.minTs === null || ts < this.minTs) this.minTs = ts;
      if (this.maxTs === null || ts > this.maxTs) this.maxTs = ts;
    }
    bump(this.projects, project);
    if (typeof rec.version === "string") bump(this.versions, rec.version);
    const model = rec?.message?.model;
    if (typeof model === "string") bump(this.models, model);
    const content = rec?.message?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block && typeof block === "object") {
          const bt = typeof block.type === "string" ? block.type : "<untyped>";
          const bkey = `content:${key.slice("record:".length)}:${bt}`;
          const bshape = this.shape(bkey);
          bshape.count++;
          bump(bshape.fileKinds, kind);
          this.walk(bshape, block, "", { n: 0 });
          if (bt === "tool_use" && typeof block.name === "string") {
            bump(this.toolNames, block.name);
            this.noteToolCall(block.name, block.input);
          }
        }
      }
    }
    if (rec.toolUseResult !== undefined) {
      const rkey = `toolResult:${key.slice("record:".length)}`;
      const rshape = this.shape(rkey);
      rshape.count++;
      bump(rshape.fileKinds, kind);
      this.walk(rshape, rec.toolUseResult, "", { n: 0 });
    }
  }

  toJSON(meta) {
    const shapes = {};
    for (const [key, s] of [...this.shapes.entries()].sort(cmpKey)) {
      const paths = {};
      for (const [p, st] of [...s.paths.entries()].sort(cmpKey)) {
        const entry = {
          count: st.count,
          presence: round(st.count / s.count, 4),
          types: [...st.types].sort(),
        };
        if (st.nullCount) entry.nulls = st.nullCount;
        if (!st.overflowed && st.values.size > 0 && st.values.size <= CATEGORICAL_MAX) {
          entry.categorical = [...st.values].sort();
        } else if (st.examples.length) {
          entry.examples = st.examples;
        }
        if (st.num && st.num.n > 0) {
          entry.numeric = {
            min: st.num.min,
            max: st.num.max,
            mean: round(st.num.sum / st.num.n, 3),
            sum: round(st.num.sum, 3),
            n: st.num.n,
          };
        }
        paths[p] = entry;
      }
      shapes[key] = { count: s.count, fileKinds: sortedTally(s.fileKinds), paths };
    }
    return {
      $schema: "aiui/cc-session-schema-snapshot@1",
      capturedAt: meta.capturedAt,
      root: meta.root,
      corpus: {
        files: this.files,
        fileKinds: sortedTally(this.fileKinds),
        bytes: this.bytes,
        records: this.records,
        parseErrors: this.parseErrors,
        timestampRange: [this.minTs, this.maxTs],
        collapsedDictPaths: [...this.dicts].sort(),
        projects: sortedTally(this.projects),
        ccVersions: sortedTally(this.versions),
        models: sortedTally(this.models),
        tools: sortedTally(this.toolNames),
      },
      shapes,
      toolSchemas: Object.fromEntries(
        [...this.toolSchemas.entries()]
          .sort((a, b) => b[1].calls - a[1].calls)
          .map(([name, t]) => [
            name,
            {
              calls: t.calls,
              params: Object.fromEntries(
                [...t.params.entries()]
                  .sort((a, b) => b[1].count - a[1].count)
                  .map(([k, p]) => [
                    k,
                    { presence: round(p.count / t.calls, 3), types: [...p.types].sort() },
                  ]),
              ),
            },
          ]),
      ),
    };
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const jsonType = (v) =>
  v === null ? "null" : Array.isArray(v) ? "array" : typeof v === "object" ? "object" : typeof v;

const round = (n, d) => (Number.isFinite(n) ? Number(n.toFixed(d)) : n);
const bump = (m, k) => m.set(k, (m.get(k) ?? 0) + 1);
const cmpKey = (a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
const sortedTally = (m) =>
  Object.fromEntries([...m.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)));

/**
 * A key set "looks like a dictionary" when the keys are data rather than a
 * fixed vocabulary: they contain path separators, are uuid-ish, or are simply
 * far too varied in length to be a hand-written struct.
 */
function looksLikeDict(keys) {
  if (keys.length === 0) return false;
  const sample = keys.slice(0, 50);
  // Strong signals: a struct field is never a file path, a uuid, or a sentence.
  // One such key is enough — `trackedFileBackups` often holds only 2-3 files,
  // so a count threshold would collapse it in some records and not others,
  // which is worse than not collapsing at all (it makes diffs non-comparable).
  const strong = sample.filter(
    (k) => k.includes("/") || k.includes(" ") || /^[0-9a-f]{8}-[0-9a-f-]{20,}$/i.test(k),
  ).length;
  if (strong / sample.length > 0.5) return true;
  // Weak signal (dotted keys) needs volume to be believable.
  if (keys.length < DICT_MIN_KEYS) return false;
  return sample.filter((k) => k.includes(".")).length / sample.length > 0.5;
}

/**
 * Claude Code writes three file shapes under `~/.claude/projects/<slug>/`:
 *
 *   <sessionId>.jsonl                                    — the main transcript
 *   <sessionId>/subagents/agent-<id>.jsonl               — one per Task subagent
 *   <sessionId>/subagents/workflows/wf_<id>/agent-*.jsonl — Workflow-spawned agents
 *   <sessionId>/subagents/workflows/wf_<id>/journal.jsonl — the workflow journal
 *
 * A tool that only globs `<slug>/*.jsonl` sees the first shape and silently
 * omits every subagent's tokens. This walker recurses.
 */
async function* walkJsonl(root) {
  const projects = await readdir(root, { withFileTypes: true });
  for (const p of projects.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (!p.isDirectory()) continue;
    yield* walkDir(path.join(root, p.name), p.name, []);
  }
}

async function* walkDir(dir, project, rel) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      yield* walkDir(full, project, [...rel, e.name]);
      continue;
    }
    if (!e.name.endsWith(".jsonl")) continue;
    yield { project, file: full, rel: [...rel, e.name], kind: fileKind(rel, e.name) };
  }
}

function fileKind(rel, name) {
  if (rel.length === 0) return "session";
  if (name === "journal.jsonl") return "workflow-journal";
  if (rel.includes("workflows")) return "workflow-agent";
  if (rel.includes("subagents")) return "subagent";
  return `other:${rel.join("/")}`;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const args = parseArgs(process.argv.slice(2));
const census = new Census();
const t0 = Date.now();

for await (const { project, file, kind } of walkJsonl(args.root)) {
  census.files++;
  bump(census.fileKinds, kind);
  try {
    census.bytes += (await stat(file)).size;
  } catch {}
  const rl = createInterface({
    input: createReadStream(file, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  let n = 0;
  for await (const line of rl) {
    if (!line.trim()) continue;
    if (++n > args.maxLines) break;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      census.parseErrors++;
      continue;
    }
    if (rec && typeof rec === "object") census.add(rec, project, kind);
  }
  if (!args.quiet && census.files % 25 === 0) {
    process.stderr.write(`  …${census.files} files, ${census.records} records\n`);
  }
}

const snapshot = census.toJSON({ capturedAt: new Date().toISOString(), root: args.root });
await mkdir(path.dirname(args.out), { recursive: true });
await writeFile(args.out, `${JSON.stringify(snapshot, null, 2)}\n`);

if (!args.quiet) {
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.error(
    `census: ${census.files} files · ${census.records} records · ` +
      `${(census.bytes / 1e6).toFixed(0)} MB · ${census.shapes.size} shapes · ${secs}s`,
  );
  console.error(`wrote ${args.out}`);
}
