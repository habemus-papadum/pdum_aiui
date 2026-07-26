# `@habemus-papadum/aiui-transcript`

Reader, normalizer and Parquet writer for **Claude Code session transcripts**.
Internal, never published — the pure-model half of `demos/ledger`, in the same
relation `demos/optics` has to the wave-optics notebooks.

```sh
pnpm -C demos/transcript normalize                              # → ./out
pnpm -C demos/transcript normalize -- --out ../ledger/src/data  # feed the demo
pnpm -C demos/transcript normalize -- --offline --no-images
```

## What it does

`~/.claude/projects/**/*.jsonl` → five Parquet tables:

| table | grain |
| --- | --- |
| `turns` | one row per **deduped API response** (47 columns) |
| `toolCalls` | one row per tool_use, joined to its result |
| `events` | compaction / fallback / refusal / relocation, payload as JSON |
| `sessions` | one row per session, wall-clock vs active time |
| `images` | one row per image payload, with estimated tokens |

Plus `manifest.json`: which price table produced the numbers, the corpus stats,
and the invariant results.

## Why it exists

`src/fields.ts` is the point of the package: the schema knowledge, encoded as
lenient accessors plus a `TRAPS` registry. Reading is total and never throws
(Claude Code shipped 28 builds in the five weeks of the baseline corpus — a
validating parser would have broken repeatedly); *noticing* drift is a separate
offline job, `exploration/cc-usage/{census,diff}.mjs`.

The traps that decide the design, each pinned by a test in `normalize.test.ts`:

- **One API response is written as one record per content block**, each
  repeating the full `message.usage`. Naive sums overstate output tokens by
  237%. Dedup for *billing* — but union the content, because the blocks are
  partitioned across those same records.
- **Forking copies the transcript prefix** into the new session's file, so one
  billed turn exists in several files (5.5% of `message.id`s). Only a corpus-wide
  dedup is correct. `session_id` (≠ `sessionId`) marks the copies, from Claude
  Code 2.1.199 onward.
- **There is no cost field.** Every dollar is derived and stamped with
  `pricingVersion`.
- **Model fallback** hides the discarded attempt outside
  `message.usage.iterations[]`.

`checkInvariants()` asserts `SUM(sessions.nativeCost) === SUM(turns.costTotal)`
and that no billing key survived twice; the CLI runs it every time and exits
non-zero on failure.

## Pricing

LiteLLM's `model_prices_and_context_window.json`, cached under `.cache/`.
Deliberately **not** `@pydantic/genai-prices` (which this repo uses elsewhere):
it models cache writes as one bucket, and Anthropic's 1-hour cache tier costs
1.6× the 5-minute one — 54.8% of cache-creation tokens here, so flat-rating
understates total spend by 6.9%. See `src/pricing.ts` and the proposal, §3.

Full design: [`docs/proposals/claude-code-usage-analytics.md`](../../docs/proposals/claude-code-usage-analytics.md).
