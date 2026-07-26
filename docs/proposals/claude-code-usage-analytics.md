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
folklore. The five that matter:

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

**(e) Forking and resuming copy the transcript prefix.** This is the fifth
critical trap and it gets its own section — see §1.6.

Lesser ones, all encoded: sidechain files can replay a parent's `message.id`
under a different `requestId` (ccusage
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

### 1.6 Forking and resuming — a file is not a session

**Forking copies; it does not reference.** When a session is resumed or forked,
Claude Code writes the inherited transcript prefix into the *new* session's
`.jsonl`, preserving `uuid`, `timestamp`, `requestId` and `message.id` byte for
byte. Worked example:

```
402656ea….jsonl   7,968 messages   2026-07-13T12:37 … 2026-07-16T11:49
52e85b58….jsonl   4,303 messages   2026-07-15T10:09 … 2026-07-16T19:28
                  └─ its first 1,333 messages ARE 402656ea's last 1,333
```

Corpus-wide: **1,615 of 29,108 distinct `message.id`s (5.5%) appear in more than
one file**, in chains up to four deep (`de93c3a5 → 70486150 → 63baa90e →
4df4dbb9`). Subagent directories are copied along with the parent, so the same
`agent-<id>.jsonl` can exist under two session dirs.

So a per-file or per-session sum double-counts. **Only a global dedup is
correct** — which the proposed `billingKey()` grouping already is, but it must be
stated as a requirement rather than left as an accident of implementation.

**The provenance field.** On a copied record:

| field | on the original | on the copy |
| --- | --- | --- |
| `sessionId` | `402656ea…` | **`52e85b58…`** — rewritten to the containing session |
| `session_id` | `402656ea…` | **`402656ea…`** — preserved: the originating session |
| `uuid` · `timestamp` · `requestId` · `message.id` | | identical |
| `slug` | `steady-watching-stream` | `null` |

This **corrects §1.3 of the first draft**, which called the `sessionId` /
`session_id` pair "a naming migration in flight". It is not a migration — it is
the fork-provenance mechanism, and it is exactly the field needed to avoid
double-counting. `session_id !== sessionId` ⟺ this record was inherited.

**It is only available from Claude Code 2.1.199.** The version split is clean:
absent on every record from `2.1.186`–`2.1.198`, present on ~100% from `2.1.199`
onward. That is the entire explanation for its ~78% presence. Consequently the
marker catches 911 of the 1,615 cross-file duplicates (56%); the other 704 are
all pre-2.1.199 records that lack the field. Content-based dedup remains
mandatory as the floor; `session_id` is what makes *attribution* correct on top
of it.

**Design consequence — the `sessions` grain changes.** A session file is not a
session. Model a **lineage**:

- Dedup globally by `billingKey()`. Every billed turn exists exactly once.
- Attribute each turn to `originSession(rec)` (`session_id` when present, else
  the earliest-timestamped file containing it). A turn is paid for once, by the
  session that produced it.
- `sessions` therefore carries `sessionId`, `originSessionId`, `lineageId`, and
  both `nativeCost` (turns it produced) and `inheritedContextTurns` (turns it
  merely carried). **Only `nativeCost` sums** — summing it over all sessions
  reproduces the corpus total exactly, which is the invariant to test.
- Fork edges are derivable: file *B* inherits from *A* when *B* contains records
  whose `session_id` is *A*. For pre-2.1.199 sessions, fall back to
  "*B*'s head uuids equal *A*'s tail uuids". Both are cheap; the lineage graph is
  worth materialising once rather than re-deriving per query.

This is also the honest answer to "did forking cost me anything?" — forking is
**free** in tokens for the inherited prefix at fork time, but every subsequent
turn in the fork re-reads that inherited context as cache-read tokens. Given
cache reads are 62.7% of spend (§1.5), the real cost of a fork is the ongoing
context weight it carries forward, and that is directly measurable per lineage.

### 1.7 Mid-session model changes are fully visible

Two distinct mechanisms, both detectable:

**Explicit switches** — `message.model` simply varies across turns within one
session file. This is common in the corpus, not exceptional:

```
claude-fable-5  → claude-opus-4-8    @ 2026-07-13T20:40:26Z
claude-opus-4-8 → claude-fable-5     @ 2026-07-13T22:22:28Z
claude-fable-5  → claude-opus-4-8    @ 2026-07-13T22:24:12Z
claude-opus-4-8 → claude-fable-5     @ 2026-07-14T11:12:37Z
```

Per-turn model is on every record, so a "model over time" lane in the session
timeline is free, and cost attribution per model within a session is exact.
(`<synthetic>` appears in these sequences too — filter it, it never hit the API.)

**Automatic downgrades/upgrades** — the fallback path of §1.3(c), logged twice
over: a `type:"system"` record carrying `originalModel` → `fallbackModel`, and
the `iterations[]` ledger on the affected assistant turn. Observed here:
`claude-fable-5 → claude-opus-4-8` (5×) and `claude-fable-5 →
claude-opus-4-8[1m]` (1×). So the answer to "am I being downgraded on the fly?"
is yes-and-it-is-recorded — with the caveat that the *discarded* attempt's tokens
appear **only** in `iterations[]`, which is precisely why that array is the
billing ground truth.

### 1.8 Agent spend is fully attributable

`attributionAgent` on sidechain records names the agent *type* and is present on
75.8% of them; `agentId` gives the instance, and `sessionId` links to the parent.
Deduped and priced over the baseline corpus:

| context | cost | share |
| --- | ---: | ---: |
| main session | $9,437.28 | 89.8% |
| subagents | $721.13 | 6.9% |
| workflow agents | $347.89 | 3.3% |

| agent type | cost |
| --- | ---: |
| `general-purpose` | $381.17 |
| `workflow-subagent` | $347.89 |
| *(unlabelled — pre-`attributionAgent` builds)* | $254.38 |
| `fork` | $65.36 |
| `Explore` | $15.72 |
| `Plan` | $4.44 |
| `claude-code-guide` | $0.06 |

Two things worth noting. Agents are **10.2% of spend** — material, but far less
than the main loop, so the "am I overusing agents?" question resolves to *no* on
this corpus. And model choice differs sharply by context: the main loop is 69%
`claude-fable-5`, while subagent spend skews to `claude-opus-4-8` ($390.60 vs
$308.76) — an agent-vs-main model-policy comparison the `turns` grain supports
directly.

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

## 3. Price table: LiteLLM vs `@pydantic/genai-prices`

The repo already depends on [`@pydantic/genai-prices`](https://github.com/pydantic/genai-prices)
in `packages/aiui-claude-channel` (`src/cost.ts`), so the default should be to
reuse it. **For this demo it is the wrong choice, for one structural reason.**

Both catalogs cover every model in the corpus, and where they overlap the rates
are identical (`claude-fable-5`: $10/$50/Mtok, cache write $12.50, cache read
$1.00). genai-prices is arguably the better-maintained of the two —
`prices_checked: 2026-07-24`, bundled offline data, historic prices, a real
TS API instead of a raw JSON fetch.

**The disqualifier is Anthropic's cache TTL tiers.** genai-prices models cache
writes as a single bucket — one `cache_write_mtok` price, one
`cache_write_tokens` usage field. Claude Code reports the two tiers separately
(`cache_creation.ephemeral_5m_input_tokens` / `ephemeral_1h_input_tokens`), and
the 1-hour tier costs **1.6×** the 5-minute one. On this corpus:

| | tokens | |
| --- | ---: | --- |
| 5m cache writes | 99,975,659 | 45.2% |
| **1h cache writes** | **121,192,650** | **54.8%** |

| cache-creation cost | | |
| --- | ---: | --- |
| tiered (LiteLLM, 1h @ 1.6×) | $2,926.89 | |
| flat (genai-prices, one rate) | $2,244.46 | **30.4% low** |
| **effect on total spend** | | **6.9% understated ($682 / 5 weeks)** |

This is not a stale-data problem that a PR fixes — genai-prices' *type* cannot
express the split, so a fix means a schema change upstream. Worth opening an
issue since we are already a consumer, but not worth blocking on.

genai-prices' one real advantage — historic prices — is **already neutralised by
the design**: §5.3 materialises cost columns into Parquet stamped with
`pricingVersion`, so price history is preserved by us rather than by the table.
LiteLLM's current-only nature costs us nothing given that.

**Decision: LiteLLM for cc-usage; genai-prices stays in the channel.** They solve
different problems — the channel prices many providers including audio, and never
touches Anthropic cache tiers; this demo prices one provider and lives or dies on
those tiers. Revisit if genai-prices grows a TTL-aware cache model.

## 4. Image tokens: not attributable from the transcript, but estimable

**Neither catalog helps here, and the reason is upstream of both.** Anthropic
does not bill images as a separate category — an image is tokenized into the
ordinary input stream. Accordingly:

- `message.usage` has exactly ten keys, and **none of them is an image counter**:
  `input_tokens`, `output_tokens`, `cache_creation_input_tokens`,
  `cache_read_input_tokens`, `cache_creation`, `iterations`, `server_tool_use`,
  `service_tier`, `speed`, `inference_geo`.
- genai-prices has audio categories but **no image category at all**.
- LiteLLM *does* carry `input_cost_per_image` / `input_cost_per_image_token` /
  `input_cost_per_pixel` — but not for Anthropic models, which only declare
  `supports_vision`. Correctly so: there is no separate image rate to declare.

So exact image attribution is impossible. **Estimation, however, is
straightforward and worth building**, because the raw images are in the
transcript as base64 and Anthropic publishes the formula (`tokens ≈ w × h / 750`).

Images ride in three places, all on `user` records:

| carrier | count |
| --- | ---: |
| `message.content[].image` | 152 |
| `message.content[].tool_result.content[].image` | 151 |
| `toolUseResult[].image` (sidecar copy of the above) | 79 |

Dimensions are recoverable from the PNG `IHDR` / JPEG `SOFn` header without
decoding the pixels — verified on 148 images, 100% success, e.g. `2000×966 →
≈2,576 tokens`, `1185×781 → ≈1,234 tokens`. Total across those 148: ≈114,000
estimated input tokens.

**Why this matters more than the raw number suggests.** 114k tokens against 2.2M
fresh input tokens looks like ~5%. But an image, once in context, is re-read as
**cache-read tokens on every subsequent turn until compaction** — and cache reads
are 62.7% of spend (§1.5). The interesting quantity is therefore not "what did
this image cost once" but "how many turns did this image ride along for", which
is computable: images have positions in the conversation, and compaction events
have boundaries.

Design additions:

- `turns` gains `nImages` and `estImageTokens` (clearly labelled as estimates).
- A new **`images`** table — one row per image payload:
  > `messageId` · `sessionId` · `ts` · `carrier` · `mediaType` · `width` ·
  > `height` · `bytesBase64` · `estTokens` · `turnsResident` · `estCacheReadCost`

  `turnsResident` is the count of subsequent turns before the next compaction —
  the multiplier that turns a 2.5k-token screenshot into real money.
- Never store the base64 itself in Parquet; a content hash is enough to
  deduplicate the same screenshot pasted twice.

The honest caveat: `w × h / 750` is Anthropic's documented approximation, and
Claude Code may downscale images before sending. Every number in the `images`
table is therefore an estimate with a systematic upward bias, and the UI must say
so — this is the one place in the design where we cannot reconcile against a
ground-truth counter, because none exists.

## 5. Design

### 5.1 Own the schema as *knowledge*, not as types

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

**Where Zod does earn its place:** the *derived* Parquet schemas of §5.3. Those
are ours, they are stable by construction, and a type error there is a real bug.
The rule: no validation at the raw-JSON boundary, full typing after normalisation.

### 5.2 Ingest pipeline

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
   normalise to grains ──────────────► Parquet  (§5.3)
        │
        ▼
   DuckDB-WASM / Mosaic ─────────────► the demo (§5.5)
```

Incremental by design: JSONL files are append-only, so record
`(path, size, mtime, lastLineOffset)` per file and re-read only the tail. The
active session's file is the only one that grows. A full 559 MB cold pass takes
**2.2 s** in plain Node — well inside "just re-scan it" territory, so
incrementality is an optimisation, not a requirement, and correctness never
depends on it.

### 5.3 The Parquet layers

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

**`sessions`** — one row per session **file**, derived from `turns` and `events`.
Fork-aware per §1.6: a file is not a session, so this grain carries both its own
identity and its lineage, and only the *native* columns are summable.
> `sessionId` · `originSessionId` · `lineageId` · `parentSessionId` ·
> `projectSlug` · `slug` · `firstTs` · `lastTs` · `spanSeconds` ·
> `activeSeconds` · `dutyCycle` · `nTurnsNative` · `nTurnsInherited` ·
> `nSubagents` · `nCompactions` · `peakContextTokens` · **`nativeCost`** ·
> `inheritedContextTokens` · `models` (list) · `ccVersions` (list)

`SUM(nativeCost)` over all rows must equal the corpus total — that is the
regression test for the whole dedup/attribution path, and it is worth asserting
in the writer rather than discovering later in a chart.

`activeSeconds` sums inter-turn gaps below a threshold (30 min default, and it
should be a control in the UI — the threshold is a judgement call, so expose it).
It must be computed over *native* turns only, or a fork inherits its ancestor's
elapsed time and reports a nonsense duty cycle.

**`lineages`** — one row per fork chain, the unit a human actually means by
"a session".
> `lineageId` · `rootSessionId` · `sessionIds` (list) · `firstTs` · `lastTs` ·
> `totalCost` · `nForks` · `depth`

Partition by month, Hive-style (`turns/month=2026-07/…`). At current volume
(29k turns / 5 weeks) the whole corpus is a few MB of Parquet and DuckDB-WASM
loads it instantly; partitioning is for the year-two case, not today.

**Keep the snapshots too.** `snapshots/<date>.json` is committed alongside the
Parquet. It is the only record of what the schema looked like when a number was
computed.

### 5.4 The drift workflow

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

### 5.5 The demo

`demos/cc-optimizer`, private to the gallery — `package.json` carries no
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

### 5.6 The two core widgets

Everything else in this tool is a conventional cross-filter panel. Two widgets
are not, and they carry the analysis — so they are specified here rather than
left to whoever builds them.

#### 5.6.1 The session timeline (git-commit-graph aesthetic)

**Shape.** Very wide, short — on the order of 100–300px tall, running the full
page width. Horizontal is time. Vertical is distinct traces.

**Content.** Each session is a horizontal track from its first to its last turn.
On those tracks: fork points, subagent launches, workflow launches. Colour (or
another channel) encodes cost, so the eye reads spend along the time axis.

**Nesting.** Traces collapse and expand. One level of nesting is the project,
which may hold several concurrent tracks — running multiple sessions in one
project at once is normal, not exceptional, so lanes must pack and be reused.

**The hard case, stated up front.** A fork's edge connects the parent's fork
point to the child's first native turn, and *those can be days apart*: forking
something you mean to return to and never do is common. So the bezier can span a
long horizontal gap with no vertical adjacency, and the layout cannot assume a
fork's child starts near its parent's end. Both endpoints must exist in the data
(§1.6 gives the provenance mechanism; the fork point is the timestamp of the last
*inherited* turn, not the child's first turn).

**Contract.** It must be a **proper `MosaicClient`** — brushing a time range
publishes a Selection clause, and other widgets' filters re-query it. The working
in-repo precedent for a hand-written client is `demos/seismos/src/stats-client.ts`.

Whether this is buildable from stock Mosaic marks is an open question; the
presumption is that it is not, and it needs a custom client.

#### 5.6.2 The turn scatter

One point per **deduped** turn (§1.3(a)), fork-aware (§1.6): x = time, y = cost
or duration, colour = project or session. 10–20k points, which is squarely
inside what vgplot handles — this one maps onto stock marks and exists to show
the distribution rather than to be clever.

It is the second half of the cross-filter: brushing the scatter should filter the
timeline and vice versa, which is exactly the cross-table question below.

#### 5.6.3 The two questions these raise

1. **Can filters built from one table apply to visualizations over another?**
   The timeline is backed by `sessions` (and a lineage/agent-run grain); the
   scatter is backed by `turns`. Mosaic has historically assumed one source-of-truth
   table with every clause built against it. If that still holds, either the schema
   denormalizes or the clauses carry semi-join predicates — both have costs.
2. **Is the timeline expressible in SQL at all?** Mosaic filtering *is* SQL
   construction, so this is a data-representation problem before it is a
   rendering problem: fork edges, lanes, and agent spans have to be columns
   something can `WHERE` against, not shapes computed in a render pass.

Both are under investigation; §7 tracks the outcome.

## 6. Open questions

- ~~Where does `fields.mjs` graduate to?~~ **Settled.** It is
  `demos/cc-slurp/src/fields.ts` — `@habemus-papadum/aiui-cc-slurp`, an internal
  never-published library beside the demo that consumes it, in the same relation
  `demos/optics` has to the wave-optics notebooks. The `.mjs` originals stay in
  `exploration/cc-usage/` as the census/drift tooling, which is deliberately
  dependency-free and outlives the workspace.
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
- **Pre-2.1.199 lineage reconstruction.** The uuid-overlap fallback (§1.6) is
  O(files²) if done naively. A uuid→file index makes it linear, but it is only
  needed for the 704 unmarked duplicates in this corpus and that fraction shrinks
  with every new session. Possibly not worth building at all — measure first.

## 7. Next steps

**Done.**

1. ~~Ship the normaliser.~~ `demos/cc-slurp` — five Parquet grains + a manifest,
   480 files / 163k records / 562 MB → 29,378 turns in 3.1s. `checkInvariants`
   asserts `SUM(sessions.nativeCost) == SUM(turns.costTotal)` and runs on every
   invocation.
2. ~~Scaffold the demo.~~ `demos/cc-optimizer` — gallery-private, DuckDB-WASM
   over the five tables, four panels, plus a `query` action giving the agent
   read-only SQL. Verified rendering against the real corpus.

**In flight.**

3. **Validate cost against ground truth.** The honest comparison is `ccusage`
   over the same window: any disagreement is diagnostic, because we know exactly
   which traps we handle that it may not (fork-copy dedup — would read high; the
   1h cache tier — would read ~7% low). The Console's billing page is the only
   true ground truth and needs a human.
4. **The two core widgets** (§5.6) and the two questions they raise: cross-table
   filtering in Mosaic, and whether the session graph is expressible in SQL.
   The data model for fork lineage / lanes / agent spans is the gating piece —
   §1.6 established the provenance mechanism but the normalizer does not yet
   emit lineage edges, only `fork-context-ref` events.

**Standing.**

5. **Re-run the census in ~3 weeks** (`exploration/cc-usage/`) and read the diff's
   `NEW` section. That is the first real test of whether the drift workflow earns
   its keep.
6. **Cross-filter the existing panels.** They are static reads today; the
   `Selection` is wired but nothing publishes into it yet.
