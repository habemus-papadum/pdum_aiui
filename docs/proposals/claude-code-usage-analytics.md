# Claude Code usage analytics — schema research and ingestion design

**Status:** research complete, design proposed, nothing built beyond the spike.
**Spike:** [`exploration/cc-usage/`](../../exploration/cc-usage/) (runnable, zero deps).
**Generated schema reference:** [`exploration/cc-usage/SCHEMA.md`](../../exploration/cc-usage/SCHEMA.md).
**Date:** 2026-07-26. Corpus: 477 files · 162,157 records · 559 MB · Claude Code `2.1.186`–`2.1.220`.

## Goal

A demo — in the aiui viz framework, **not** published to the gallery — that lets a
technical user understand and optimise their own Claude Code usage: patterns,
projects, cost per turn, cost in aggregate, and where the waste is. This
document covers only the first step: **how we ingest the session logs, and how
we keep up as the schema moves.**

## 1. What is actually on disk

### 1.1 Four file shapes, not one

```
~/.claude/projects/<project-slug>/
  <sessionId>.jsonl                                       ← 109 files   the main transcript
  <sessionId>/subagents/agent-<id>.jsonl                  ← 186 files   one per Task subagent
  <sessionId>/subagents/workflows/wf_<id>/agent-<id>.jsonl ← 175 files  Workflow-spawned agents
  <sessionId>/subagents/workflows/wf_<id>/journal.jsonl    ←   7 files  workflow journal
```

The project slug is the absolute cwd with `/` → `-`. `CLAUDE_CONFIG_DIR` can
relocate the root, and `~/.config/claude/projects/` is an alternative location.

**77% of files, and 29.6% of all assistant records, are not at the top level.**
A tool globbing `<project>/*.jsonl` silently omits every subagent's tokens. This
is the single easiest way to be badly wrong about cost, and it gets worse the
more you use subagents and workflows.

### 1.2 The record union

The transcript is a tagged union on `type` — 20 values observed:

`assistant` · `user` · `last-prompt` · `mode` · `permission-mode` ·
`bridge-session` · `ai-title` · `attachment` · `agent-name` · `custom-title` ·
`file-history-snapshot` · `system` · `file-history-delta` · `relocated` ·
`worktree-state` · `queue-operation` · `pr-link` · `started` · `result` ·
`fork-context-ref`

`assistant` and `user` are themselves unions: boolean discriminants
(`isSidechain`, `isMeta`, `isCompactSummary`, `isApiErrorMessage`) materially
change the field set, and `message.content[]` is a further union
(`text` · `thinking` · `tool_use` · `tool_result` · `image` · `fallback`).
The census therefore profiles 47 distinct shapes across 1,647 field paths.

`started` / `result` appear **only** in workflow journals — a whole record
vocabulary that exists in one file kind.

### 1.3 The traps

These are encoded in [`fields.mjs`](../../exploration/cc-usage/fields.mjs) as a
`TRAPS` list, with a `detect` recipe each, so they are testable rather than
folklore. The four that matter:

**(a) One API response is written as many records.** Claude Code emits **one
record per content block**, each carrying a byte-identical `message.usage`. A
response with thinking + text + tool_use is three records claiming the same
tokens.

| | |
| --- | --- |
| assistant records | 69,187 |
| distinct `message.id` | 29,050 |
| records per response | **2.38×** |
| naive output-token sum | 86,394,818 |
| deduped | 25,603,020 |
| **naive overstates by** | **237%** |

The overcount is *worse* than the record ratio because duplication correlates
with response size — 1-block responses average 552 output tokens, 5-block
responses 4,366. Group by `(message.id, requestId)` and take one member.

**(b) There is no cost field.** `grep costUSD ~/.claude/projects` returns
nothing. `total_cost_usd` does not exist either. Every dollar figure any tool
shows — including ours — is derived from tokens times an external price table.
This must be surfaced in the UI, not hidden.

**(c) Model fallback hides billed tokens.** `message.usage.iterations[]` is the
real per-attempt ledger. When a cheap model's attempt is abandoned and retried
on a stronger one, iterations holds **both** attempts with their own `model`
fields, while top-level `message.usage` reflects only the last. Pricing the top
level drops the discarded attempt. Rare in this corpus (5 responses, 1,781
tokens) but it is a correctness hole that grows with routing features, and
`iterations[]` is present on 99.96% of records — it is the ground truth, not an
extra.

**(d) Model ids carry priced variants.** `claude-opus-4-8[1m]` (1M context)
prices differently from `claude-opus-4-8`. `<synthetic>` is a locally generated
message that never hit the API and must never be priced.

Lesser ones, all encoded: `sessionId` and `session_id` coexist on the same
records (a rename in flight, 100% vs 78%); sidechain files can replay a parent's
`message.id` under a different `requestId` (ccusage
[#913](https://github.com/ccusage/ccusage/issues/913)) — not present in this
corpus but cheap to defend against; `toolUseResult` is polymorphic
(`object | array | string`).

### 1.4 The analytic surface is richer than "tokens"

The fields that make this worth building, all confirmed present:

| what | where | note |
| --- | --- | --- |
| **cost attribution** | `attributionSkill`, `attributionPlugin`, `attributionMcpServer`, `attributionMcpTool` on `assistant` | which skill / MCP server caused this spend — 3.8% / 2.8% / 5.9% of records |
| **reasoning effort** | `effort` (`medium`/`high`/`xhigh`), 30% | pairs with output tokens to price thinking |
| **compaction** | `system.compactMetadata.*` | `preTokens`, `postTokens`, `trigger` (`auto`/`manual`), `durationMs`, `cumulativeDroppedTokens`, preserved-message uuids |
| **model fallback** | `system.originalModel` → `system.fallbackModel` | observed `claude-fable-5 → claude-opus-4-8[1m]` |
| **refusals** | `system.apiRefusalCategory`, `refusedUserMessageUuid` | |
| **wasted work** | `isAbortedMidStream`, `isApiErrorMessage`, `interruptedMessageId` | |
| **permission friction** | `user.toolDenialKind`, `user.permissionMode`, `user.promptSource`, `user.origin.kind` | |
| **tool outcomes** | `toolUseResult.{success,error,interrupted,exitCode,durationMs}` | bash failures are directly countable |
| **cache TTL split** | `message.usage.cache_creation.ephemeral_{5m,1h}_input_tokens` | priced differently — 1h ≈ 2× 5m |
| **server tools** | `message.usage.server_tool_use.{web_search,web_fetch}_requests` | billed per request, not per token |
| **background work** | `sessionKind: "bg"`, `pendingBackgroundAgentCount`, `pendingWorkflowCount` | |
| **provenance** | `cwd`, `gitBranch`, `version`, `entrypoint`, `slug` | project + build attribution for free |

### 1.5 What the baseline corpus already shows

Five weeks, derived at LiteLLM prices:

| class | cost | share |
| --- | ---: | ---: |
| cache read | $6,585.16 | **62.7%** |
| cache creation | $2,920.51 | 27.8% |
| output | $974.72 | 9.3% |
| input | $15.39 | **0.1%** |
| **total** | **$10,495.78** | |

Cache reads are 3,678× fresh input tokens. **Over 90% of spend is context
re-transmission, not generation.** That single fact reframes what "using Claude
Code efficiently" means — it is a context-management problem far more than a
prompting one, and it is exactly what the demo should make visible.

Session shape is the other half. Sampling five large sessions:

| session | wall-clock span | active time | duty cycle |
| --- | ---: | ---: | ---: |
| `629feca4` | 5.4 days | 5.1 h | **4%** |
| `2abc604b` | 1.9 days | 10.4 h | 23% |
| `05ded981` | 1.2 days | 8.7 h | 30% |
| `95915269` | 0.4 days | 6.7 h | 78% |

Exactly the "ran for five calendar days, actually seven hours" shape asked for,
and it falls straight out of timestamps with a gap threshold.

## 2. Existing tools — surveyed, not adopted

| repo | ★ | lang | last push | verdict |
| --- | ---: | --- | --- | --- |
| [`ryoppippi/ccusage`](https://github.com/ryoppippi/ccusage) | 17.5k | Rust | 2026-07-26 | The reference implementation. Read it; don't depend on it. |
| [`phuryn/claude-usage`](https://github.com/phuryn/claude-usage) | 2.1k | Python | 2026-07-10 | Local dashboard, subscription-limit framing. |
| [`li195111/claude-token-analyzer`](https://github.com/li195111/claude-token-analyzer) | 15 | Rust | 2026-04-14 | JSONL→SQLite + anomaly detection. Closest in spirit to the "find problems" goal. |
| [`lucemia/claude-session-analyzer`](https://github.com/lucemia/claude-session-analyzer) | 13 | Python | 2026-04-11 | Behavioural metrics (thinking depth, Read:Edit ratio). |
| [`kolkov/ccdiag`](https://github.com/kolkov/ccdiag) | 3 | Go | 2026-04-03 | Proxy-based; different data source entirely. |
| [`haasonsaas/claude-usage-tracker`](https://github.com/haasonsaas/claude-usage-tracker) | 3 | TS | 2026-02-03 | Stale. |

**ccusage is the only one worth studying closely**, and its `adapter/claude/README.md`
is the best written record of these quirks anywhere. Three things to take from it:

1. **Lenient deserialisation as doctrine.** Its `jsonl.rs` provides
   `lenient_u64` / `lenient_i64` / `lenient_object` helpers whose entire purpose
   is that an unexpectedly-typed field degrades to a default instead of
   discarding an otherwise usable record. This is the correct posture for a log
   format that changes weekly and we should copy it exactly.
2. **Pricing from LiteLLM's
   [`model_prices_and_context_window.json`](https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json)**,
   with `models.dev` as fallback and an embedded build-time copy so it works
   offline. Verified: it carries bare keys for every model in this corpus, with
   `cache_creation_input_token_cost_above_1hr` matching the 5m/1h split exactly.
3. **The sidechain-replay dedup rule** (keep the parent entry, drop the copy that
   carries `isSidechain: true`).

**Why own the parsing anyway.** ccusage answers "what did I spend"; we want "why,
and what should I change". That needs the attribution / compaction / fallback /
tool-outcome fields it has no reason to model, at turn and session grain, joined
to time. Its cost core is ~5k lines of Rust behind a CLI; we would be extracting
one number and re-deriving everything else. The schema knowledge is the valuable
part and it is ~400 lines — already written in `fields.mjs`. Take the doctrine,
take the price table, keep the model.

## 3. Design

### 3.1 Own the schema as *knowledge*, not as types

The user's instinct — string-based, functional, no heavy Zod layer — is right,
for a specific reason: **a validating parser converts every Claude Code release
into an outage.** 28 builds shipped during the five weeks of this corpus. A
schema that rejects unknown fields would have broken repeatedly; one that
accepts them silently would teach us nothing.

So the split is:

- **Reading is lenient and total.** `fields.mjs` accessors never throw, never
  assume presence, and degrade to null-ish. Unknown fields ride along untouched.
- **Noticing is a separate, loud, offline job.** `census.mjs` + `diff.mjs`
  profile the corpus and report drift. Schema knowledge lives in a data
  structure (`DIMENSIONS`, `TRAPS`) that is *documentation the code reads*, not
  a validator.

Functional style works here without pipe syntax because the accessors are shallow
(`billableUnits(rec)`, `compaction(rec)`, `toolOutcome(rec)`) — record in,
plain object out. The composition happens in the aggregation loop, not in a chain.

**Where Zod does earn its place:** the *derived* Parquet schemas of §3.3. Those
are ours, they are stable by construction, and a type error there is a real bug.
The rule: no validation at the raw-JSON boundary, full typing after normalisation.

### 3.2 Ingest pipeline

```
~/.claude/projects/**/*.jsonl
        │  recursive walk, tag each file with its kind
        ▼
   lenient reader (fields.mjs)         ── never throws, never drops
        │
        ├─► census / diff  ────────────► schema drift report   (offline, periodic)
        │
        ▼
   dedup by (message.id, requestId), prefer non-sidechain
        │
        ▼
   normalise to grains ──────────────► Parquet  (§3.3)
        │
        ▼
   DuckDB-WASM / Mosaic ─────────────► the demo (§3.5)
```

Incremental by design: JSONL files are append-only, so record
`(path, size, mtime, lastLineOffset)` per file and re-read only the tail. The
active session's file is the only one that grows. A full 559 MB cold pass takes
**2.2 s** in plain Node — well inside "just re-scan it" territory, so
incrementality is an optimisation, not a requirement, and correctness never
depends on it.

### 3.3 The Parquet layers

Four tables, at four grains. Everything downstream is a query over these; they
are the contract.

**`turns`** — one row per *deduped API response*. The workhorse fact table.
> `messageId` · `requestId` · `sessionId` · `fileSessionId` · `projectSlug` ·
> `cwd` · `gitBranch` · `ts` · `model` · `modelVariant` · `effort` ·
> `stopReason` · `serviceTier` · `speed` · `isSidechain` · `agentId` ·
> `entrypoint` · `sessionKind` · `ccVersion` · `attributionSkill` ·
> `attributionPlugin` · `attributionMcpServer` · `attributionMcpTool` ·
> `inputTokens` · `outputTokens` · `cacheCreate5m` · `cacheCreate1h` ·
> `cacheReadTokens` · `webSearches` · `webFetches` · `hadFallback` ·
> `wastedOutputTokens` · `nBlocks` · `nThinkingChars` · `nToolUses` ·
> `costInput` · `costOutput` · `costCacheCreate` · `costCacheRead` ·
> `pricingVersion`

Cost columns are **materialised** and stamped with `pricingVersion`, so a price
table refresh never silently changes history. Re-derivable on demand.

**`toolCalls`** — one row per tool_use, joined to its result.
> `messageId` · `toolUseId` · `ts` · `toolName` · `isMcp` · `mcpServer` ·
> `ok` · `errorKind` · `interrupted` · `exitCode` · `durationMs` ·
> `inputBytes` · `resultBytes` · `denied`

Answers "which tools fail, how often, and what do retries cost".

**`events`** — one row per notable non-turn record. A sparse, tall table.
> `ts` · `sessionId` · `kind` (`compaction` · `fallback` · `refusal` ·
> `abort` · `permission-denial` · `queue` · `relocation` · `fork` ·
> `pr-link` · `worktree`) · `payload` (JSON string — deliberately untyped)

`payload` stays a JSON blob precisely because this is where new Claude Code
features land first. DuckDB reads JSON out of a string column fine, so a new
event kind is queryable the day it appears without a migration.

**`sessions`** — one row per session, derived from `turns` and `events`.
> `sessionId` · `projectSlug` · `slug` · `firstTs` · `lastTs` · `spanSeconds` ·
> `activeSeconds` · `dutyCycle` · `nTurns` · `nSubagents` · `nCompactions` ·
> `peakContextTokens` · `totalCost` · `models` (list) · `ccVersions` (list)

`activeSeconds` sums inter-turn gaps below a threshold (30 min default, and it
should be a control in the UI — the threshold is a judgement call, so expose it).

Partition by month, Hive-style (`turns/month=2026-07/…`). At current volume
(29k turns / 5 weeks) the whole corpus is a few MB of Parquet and DuckDB-WASM
loads it instantly; partitioning is for the year-two case, not today.

**Keep the snapshots too.** `snapshots/<date>.json` is committed alongside the
Parquet. It is the only record of what the schema looked like when a number was
computed.

### 3.4 The drift workflow

Every few weeks (or on a `claude` version bump):

```sh
cd exploration/cc-usage
node census.mjs --out snapshots/$(date +%F).json
node diff.mjs snapshots/<previous>.json snapshots/$(date +%F).json   # exit 1 = BREAKING
node report.mjs snapshots/$(date +%F).json > SCHEMA.md
```

`diff.mjs` classifies:

| level | meaning | action |
| --- | --- | --- |
| `BREAKING` | a watch-listed path vanished or changed type | fix before re-ingesting; exits 1 |
| `NEW` | a shape, field, tool, or tool parameter that did not exist | **read these** — this is how we learn what Claude Code shipped |
| `WIDENED` | a categorical field gained a member (new model, new stop reason) | usually a one-line addition |
| `CHANGED` | type change off the watch list, or presence collapse | triage |
| `GONE` | field no longer observed | often just corpus composition |

The watch list is the billing surface, because those are the changes that
corrupt numbers **silently** rather than crashing loudly. Everything else is
allowed to be noisy.

Two design notes learned by building it: tool-call `input` payloads are censused
separately (`toolSchemas`) because they are the *tool's* schema — walking them
inline produced 435 findings, of which ~400 were noise; and data-keyed maps
(`trackedFileBackups`, keyed by the user's own file paths) collapse to `{}` on a
key-shape signal, not a count threshold, because a count threshold collapses the
same field in some records and not others and makes snapshots non-comparable.

### 3.5 The demo

`demos/ccusage` (name TBD), private to the gallery — `package.json` carries no
`aiui.sitePage` marker, so `demo-discovery.ts` will not pick it up, and it stays
`"private": true` like every demo. It still gets `typecheck` and version
lockstep for free.

Mosaic/DuckDB-WASM over the Parquet, cross-filtered, per the `demos/seismos`
pattern. Views, roughly in build order:

1. **Spend over time** — date × cost per turn, coloured by project; brush to
   filter everything else. The entry point.
2. **Token-class breakdown** — the 62.7%-cache-read fact, per project and per
   session. This is the view that changes behaviour.
3. **Session timeline** — one session, wall-clock vs active, with compaction
   events, model switches, and context growth marked. The "five days, seven
   hours" view.
4. **Attribution treemap** — cost by skill / MCP server / tool. Which parts of
   the setup earn their keep.
5. **Friction panel** — tool failure rates, permission denials, aborted streams,
   refusals. Cheap to compute, directly actionable.

Data flows in as `?url` Parquet asset imports (the `demos/seismos` precedent) so
the demo runs standalone without a live scan.

## 4. Open questions

- **Where does `fields.mjs` graduate to?** A package (`aiui-cc-schema`) is the
  natural home if anything else ever wants it; otherwise it lives in the demo.
  Defer until the demo exists — premature packaging is cheaper to avoid than to
  undo.
- **Subscription vs API framing.** Flat-rate users don't pay these dollars. The
  honest framing is "API-equivalent value", useful for attribution and
  comparison. Worth a UI affordance, and worth checking whether rate-limit
  windows (ccusage's 5-hour "blocks") are the more meaningful budget axis.
- **Context growth over a session** needs `cache_read_input_tokens` as a proxy
  for context size at each turn. It should track it closely (the cache read *is*
  the prefix) but that should be validated against `compactMetadata.preTokens`
  at compaction boundaries before any chart claims to show "context size".
- **Multi-machine.** Logs are per-machine. Out of scope for v1; noted because the
  Parquet layout would need a `host` column and it is far cheaper to add now.

## 5. Next steps

1. **Ship the normaliser** — `census.mjs`'s walker + `fields.mjs`'s accessors,
   plus dedup, into a `turns`/`toolCalls`/`events`/`sessions` Parquet writer.
   The reader half is done and measured; this is assembly.
2. **Validate cost against ground truth** — reconcile a month against `/usage`
   or the Console's billing page. Every number after this depends on that
   reconciliation being done once, honestly.
3. **Scaffold the demo**, wire Mosaic to the Parquet, build view (1) end to end
   before adding others.
4. **Re-run the census in ~3 weeks** and read the `NEW` section. That is the
   first real test of whether the drift workflow earns its keep.
