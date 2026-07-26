# `cc-usage/` — Claude Code session-log schema spike

Research tooling for a planned demo that analyses **your own Claude Code usage**:
cost per turn, cost in aggregate, where the money actually goes, and whether a
session was time well spent. This directory is step 1 — *understanding and
owning the schema*. The design that follows from it is
[`docs/proposals/claude-code-usage-analytics.md`](../../docs/proposals/claude-code-usage-analytics.md).

Zero dependencies, plain Node ESM. Nothing here imports the workspace, so it
keeps running regardless of what the monorepo does.

## The four tools

```sh
node census.mjs --out snapshots/$(date +%F).json   # walk every JSONL, profile the schema
node report.mjs snapshots/$(date +%F).json > SCHEMA.md   # render it for humans
node diff.mjs snapshots/<old>.json snapshots/<new>.json  # what changed since last time
node tally.mjs                                    # prove the traps are real, in numbers
```

| file | role |
| --- | --- |
| `census.mjs` | Streams `~/.claude/projects/**/*.jsonl` and records, per record shape, every field path, its JSON types, presence, value set (when low-cardinality) and numeric range. Emits a deterministic, diffable snapshot. |
| `diff.mjs` | Compares two snapshots and reports `BREAKING` / `NEW` / `CHANGED` / `WIDENED` / `GONE`. Exits 1 on `BREAKING`, so it can gate CI. |
| `report.mjs` | Renders a snapshot as [`SCHEMA.md`](./SCHEMA.md). Generated — never hand-edited, so it cannot drift from disk. |
| `fields.mjs` | **The knowledge layer.** Lenient accessors plus an encoded registry of categorical dimensions and known traps. This is the artifact meant to graduate into a package. |
| `pricing.mjs` | Derives dollars from tokens via LiteLLM's price table, because the transcript contains no cost field. |
| `tally.mjs` | Measurement harness: runs `fields.mjs` over the live corpus and prints how wrong a naive reader would be. |

## The drift workflow

`snapshots/2026-07-26.json` is the committed baseline. Every few weeks:

```sh
node census.mjs --out snapshots/$(date +%F).json
node diff.mjs snapshots/<previous>.json snapshots/$(date +%F).json
node report.mjs snapshots/$(date +%F).json > SCHEMA.md
```

Read the `NEW` section — that is where Claude Code features show up as fields
before they are documented anywhere. Commit the new snapshot and the regenerated
`SCHEMA.md`; the diff between the two committed snapshots is the changelog.

`diff.mjs` treats a fixed watch-list (the billing surface: `message.id`,
`message.usage.*`, `timestamp`, `sessionId`, …) as load-bearing — a type change
or disappearance there is `BREAKING` rather than informational, because those
are the changes that corrupt numbers silently instead of crashing loudly.

## What the July 2026 baseline says

477 files · 162,157 records · 559 MB · 28 Claude Code builds (`2.1.186`–`2.1.220`)
· 2026-06-19 → 2026-07-26.

Run `node tally.mjs` for the current numbers. At baseline:

- A naive record-sum overstates **output tokens by 237%** and **cache-read
  tokens by 123%**.
- **29.6%** of assistant records live in subagent/workflow files a flat glob misses.
- Derived spend for the window is **$10,496**, of which **62.7% is cache reads**
  and only **0.1% is fresh input**.

## Caveats

- `report.mjs`/`diff.mjs` read only what the corpus contains. A field absent
  here may exist for other users (MCP-heavy setups, Bedrock/Vertex, teams).
  `GONE` therefore means "not in this corpus", not "removed from Claude Code".
- Tool-call `input` payloads are deliberately opaque to the census (they are the
  *tool's* schema, not the transcript's) and are censused shallowly into
  `toolSchemas` instead. Same for `answers` and todo arrays.
- `toolResult:*` shapes are still noisy: a tool result's structure is per-tool,
  so ~110 of the paths there are really "the Task tool returns this". Worth
  sharding by tool name if it becomes annoying.
- Dollar figures are **derived estimates**, always labelled with the price-table
  timestamp. Subscription users pay a flat rate; these numbers are API-equivalent
  value, useful for comparison and attribution, not a bill.
