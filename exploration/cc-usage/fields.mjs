/**
 * fields.mjs — everything we know about Claude Code's transcript schema,
 * encoded as accessor functions rather than as a validating type system.
 *
 * The design bet (docs/proposals/claude-code-usage-analytics.md §3.1): Claude Code ships a new
 * build every few days and adds fields freely. A validating parser turns every
 * such addition into a crash or a silent record drop. What we actually need is
 * a **lenient reader plus a loud census** — read defensively here, and let
 * `census.mjs`/`diff.mjs` be the thing that notices the schema moved.
 *
 * So every accessor below obeys three rules:
 *   1. Never throw on a malformed record — return a null-ish value.
 *   2. Never assume a field exists; presence is data (see PRESENCE below).
 *   3. Encode *semantics* the raw JSON does not: which fields are categorical,
 *      which are billing ground truth, which are traps.
 */

// ---------------------------------------------------------------------------
// safe navigation
// ---------------------------------------------------------------------------

/** `get(rec, 'message.usage.input_tokens')` — never throws. */
export const get = (obj, dotted) => {
  let cur = obj;
  for (const k of dotted.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[k];
  }
  return cur;
};

export const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
export const str = (v) => (typeof v === "string" ? v : undefined);
export const arr = (v) => (Array.isArray(v) ? v : []);

// ---------------------------------------------------------------------------
// record identity & kind
// ---------------------------------------------------------------------------

export const recordType = (rec) => str(rec?.type) ?? "<missing>";
export const isAssistant = (rec) => rec?.type === "assistant";
export const isUser = (rec) => rec?.type === "user";
/** True for records produced inside a Task subagent / Workflow agent. */
export const isSidechain = (rec) => rec?.isSidechain === true;

/**
 * The billing dedup key. **This is the single most important function here.**
 *
 * Claude Code writes ONE RECORD PER CONTENT BLOCK of an assistant turn — a
 * response with thinking + text + tool_use becomes three records, each carrying
 * a byte-identical `message.usage`. Summing usage over records overcounts by
 * ~2.4x on a real corpus. Group by this key and take ONE member.
 *
 * `requestId` is included because sidechain files replay parent messages with
 * the same `message.id` but a different `requestId`; see `preferOriginal`.
 */
export const billingKey = (rec) => {
  const id = str(get(rec, "message.id"));
  if (!id) return undefined;
  // NUL joins the two ids: it cannot occur inside either, so the composite key
  // is unambiguous. Written as an escape, never as a literal — a raw NUL in the
  // source makes git treat the whole file as binary.
  return `${id}\u0000${str(rec?.requestId) ?? ""}`;
};

/** Weaker key used to catch sidechain replays of a parent message. */
export const messageId = (rec) => str(get(rec, "message.id"));

/**
 * When two records share a `message.id` but differ in `requestId`, keep the
 * non-sidechain one — the sidechain copy is a replay of the parent's turn and
 * its tokens were never separately billed. (ccusage issue #913.)
 */
export const preferOriginal = (a, b) => (isSidechain(a) && !isSidechain(b) ? b : a);

/**
 * True when this record was COPIED into its file by a fork/resume rather than
 * produced there. Its tokens were billed once, to `originSession(rec)`.
 *
 * Only decidable from Claude Code 2.1.199 onward — earlier builds omit
 * `session_id`, so an inherited record from those builds is indistinguishable
 * from a native one and must be caught by cross-file dedup instead.
 */
export const isInherited = (rec) => {
  const origin = str(rec?.session_id);
  const container = str(rec?.sessionId);
  return Boolean(origin && container && origin !== container);
};

/** The session that actually paid for this turn. Falls back to the container. */
export const originSession = (rec) => str(rec?.session_id) ?? str(rec?.sessionId);

/** The session whose file this record lives in. */
export const containingSession = (rec) => str(rec?.sessionId);

/**
 * A subagent that inherits its parent's context declares it in a
 * `fork-context-ref` record: `{ agentId, parentSessionId, parentLastUuid,
 * contextLength }`. Note these records are themselves copied when the parent
 * session is forked, so the same agentId can appear under two session dirs.
 */
export const forkContextRef = (rec) =>
  rec?.type === "fork-context-ref"
    ? {
        agentId: str(rec.agentId),
        parentSessionId: str(rec.parentSessionId),
        parentLastUuid: str(rec.parentLastUuid),
        contextLength: num(rec.contextLength),
      }
    : undefined;

/**
 * Which agent produced this record. `attributionAgent` names the agent TYPE
 * (`Explore`, `Plan`, `general-purpose`, `fork`, a custom agent name, …) and is
 * present on ~76% of sidechain records; `agentId` is the per-instance id.
 */
export const agentIdentity = (rec) =>
  isSidechain(rec)
    ? { agentId: str(rec.agentId), agentType: str(rec.attributionAgent) }
    : undefined;

// ---------------------------------------------------------------------------
// usage / tokens — the billing surface
// ---------------------------------------------------------------------------

/** The five token counters that exist on every `message.usage`. */
export const TOKEN_FIELDS = /** @type {const} */ ([
  "input_tokens",
  "output_tokens",
  "cache_creation_input_tokens",
  "cache_read_input_tokens",
]);

/** Cache creation splits by TTL; the 1h tier is priced higher than the 5m tier. */
export const CACHE_TTL_FIELDS = /** @type {const} */ ([
  "cache_creation.ephemeral_5m_input_tokens",
  "cache_creation.ephemeral_1h_input_tokens",
]);

export const readUsage = (usage) => ({
  input: num(usage?.input_tokens),
  output: num(usage?.output_tokens),
  cacheCreate: num(usage?.cache_creation_input_tokens),
  cacheRead: num(usage?.cache_read_input_tokens),
  cache5m: num(get(usage, "cache_creation.ephemeral_5m_input_tokens")),
  cache1h: num(get(usage, "cache_creation.ephemeral_1h_input_tokens")),
  webSearches: num(get(usage, "server_tool_use.web_search_requests")),
  webFetches: num(get(usage, "server_tool_use.web_fetch_requests")),
  serviceTier: str(usage?.service_tier),
  speed: str(usage?.speed),
});

/**
 * Billing ground truth for one assistant record, as a list of (model, usage)
 * pairs — plural because of model fallback.
 *
 * `message.usage.iterations[]` is the real per-attempt ledger. On a fallback
 * (`type: "fallback_message"`), iterations holds BOTH the aborted cheap-model
 * attempt and the expensive retry, each with its own `model`, while top-level
 * `message.usage` reflects only the LAST attempt. Pricing the top level alone
 * silently drops the wasted first attempt.
 *
 * When `iterations` is absent (older Claude Code builds) we fall back to the
 * top-level usage under `message.model`.
 */
export const billableUnits = (rec) => {
  const usage = get(rec, "message.usage");
  if (!usage) return [];
  const topModel = str(get(rec, "message.model"));
  const iterations = arr(usage.iterations);
  if (iterations.length === 0) {
    return [{ model: topModel, iterationType: undefined, ...readUsage(usage) }];
  }
  return iterations.map((it) => ({
    // per-iteration `model` only appears when it differs from the top-level one
    model: str(it?.model) ?? topModel,
    iterationType: str(it?.type),
    ...readUsage(it),
  }));
};

/** A fallback happened: a cheaper model's attempt was thrown away and retried. */
export const hadFallback = (rec) =>
  arr(get(rec, "message.usage.iterations")).some((it) => it?.type === "fallback_message");

/**
 * Models that must never be priced. `<synthetic>` is Claude Code's own
 * placeholder for locally-generated assistant messages (e.g. an interrupt
 * notice) — it never hit the API.
 */
export const UNPRICED_MODELS = new Set(["<synthetic>"]);

/**
 * Model ids may carry a bracketed context-window variant, e.g.
 * `claude-opus-4-8[1m]`, which is priced differently from the base model.
 * Returns `{ base, variant }`.
 */
export const splitModel = (model) => {
  const m = /^(.*?)\[([^\]]+)\]$/.exec(model ?? "");
  return m ? { base: m[1], variant: m[2] } : { base: model, variant: undefined };
};

// ---------------------------------------------------------------------------
// categorical dimensions — the cross-filter axes for the Mosaic layer
// ---------------------------------------------------------------------------

/**
 * Every low-cardinality field worth exposing as a filterable dimension, with
 * where it lives and what it means. Grouped by the grain it applies to.
 *
 * `presence` is the fraction of records carrying the field in the July 2026
 * corpus — a reminder that most of these are optional and a chart must handle
 * the null bucket.
 */
export const DIMENSIONS = [
  // --- turn grain (record:assistant) ---
  { name: "model", path: "message.model", grain: "assistant", presence: 1.0 },
  { name: "stopReason", path: "message.stop_reason", grain: "assistant" },
  { name: "serviceTier", path: "message.usage.service_tier", grain: "assistant" },
  { name: "speed", path: "message.usage.speed", grain: "assistant" },
  {
    name: "effort",
    path: "effort",
    grain: "assistant",
    presence: 0.3,
    values: ["medium", "high", "xhigh"],
  },
  { name: "entrypoint", path: "entrypoint", grain: "any", values: ["cli", "sdk-cli"] },
  {
    name: "sessionKind",
    path: "sessionKind",
    grain: "any",
    presence: 0.01,
    note: '"bg" = background session',
  },
  { name: "userType", path: "userType", grain: "any" },
  { name: "isSidechain", path: "isSidechain", grain: "any", note: "true inside a subagent" },

  // --- attribution: what *caused* this spend. The efficiency axis. ---
  { name: "attributionSkill", path: "attributionSkill", grain: "assistant", presence: 0.038 },
  { name: "attributionPlugin", path: "attributionPlugin", grain: "assistant", presence: 0.028 },
  {
    name: "attributionMcpServer",
    path: "attributionMcpServer",
    grain: "assistant",
    presence: 0.059,
  },
  { name: "attributionMcpTool", path: "attributionMcpTool", grain: "assistant", presence: 0.059 },

  // --- project / place ---
  { name: "cwd", path: "cwd", grain: "any", note: "high cardinality but the real project key" },
  { name: "gitBranch", path: "gitBranch", grain: "any" },
  { name: "version", path: "version", grain: "any", note: "Claude Code build — the drift axis" },

  // --- user grain ---
  { name: "permissionMode", path: "permissionMode", grain: "user", presence: 0.047 },
  { name: "promptSource", path: "promptSource", grain: "user", presence: 0.047 },
  { name: "originKind", path: "origin.kind", grain: "user", presence: 0.047 },
  { name: "toolDenialKind", path: "toolDenialKind", grain: "user", presence: 0.0004 },

  // --- system grain ---
  { name: "level", path: "level", grain: "system", values: ["info", "notice", "warning"] },
  {
    name: "compactTrigger",
    path: "compactMetadata.trigger",
    grain: "system",
    values: ["auto", "manual"],
  },
  { name: "apiRefusalCategory", path: "apiRefusalCategory", grain: "system", presence: 0.003 },
];

// ---------------------------------------------------------------------------
// event extraction — the "what went wrong / what got expensive" signals
// ---------------------------------------------------------------------------

/** Context compaction: the single biggest driver of cache-read cost. */
export const compaction = (rec) => {
  const cm = rec?.compactMetadata;
  if (!cm) return undefined;
  return {
    trigger: str(cm.trigger),
    preTokens: num(cm.preTokens),
    postTokens: num(cm.postTokens),
    droppedCumulative: num(cm.cumulativeDroppedTokens),
    durationMs: num(cm.durationMs),
    preservedCount: arr(get(cm, "preservedMessages.uuids")).length,
    toolsDiscovered: arr(cm.preCompactDiscoveredTools).length,
  };
};

/** Model fallback events are logged as `type:"system"` with these two fields. */
export const fallbackEvent = (rec) => {
  const from = str(rec?.originalModel);
  const to = str(rec?.fallbackModel);
  return from || to ? { from, to } : undefined;
};

/** Work that was paid for and thrown away. */
export const isWasted = (rec) =>
  rec?.isAbortedMidStream === true || rec?.isApiErrorMessage === true;

/** Tool call issued by the assistant. */
export const toolUses = (rec) =>
  arr(get(rec, "message.content"))
    .filter((b) => b?.type === "tool_use")
    .map((b) => ({ id: str(b.id), name: str(b.name), input: b.input }));

/**
 * Tool outcome, read from the `toolUseResult` sidecar on the *user* record that
 * carries the tool_result. Polymorphic: object | array | string, so this is
 * pure defensive reading.
 */
export const toolOutcome = (rec) => {
  const r = rec?.toolUseResult;
  if (r == null) return undefined;
  if (typeof r === "string") return { shape: "string", ok: undefined, chars: r.length };
  if (Array.isArray(r)) return { shape: "array", ok: undefined, n: r.length };
  return {
    shape: "object",
    ok: typeof r.success === "boolean" ? r.success : undefined,
    interrupted: r.interrupted === true,
    error: str(r.error) || (typeof r.stderr === "string" && r.stderr ? r.stderr : undefined),
    exitCode: typeof r.exitCode === "number" ? r.exitCode : undefined,
    durationMs: typeof r.durationMs === "number" ? r.durationMs : undefined,
  };
};

/** Content-block census for one assistant record (records are per-block). */
export const blockTypes = (rec) => arr(get(rec, "message.content")).map((b) => str(b?.type));

/** Thinking is billed as output tokens; tracking it separately explains spend. */
export const thinkingChars = (rec) =>
  arr(get(rec, "message.content"))
    .filter((b) => b?.type === "thinking")
    .reduce((n, b) => n + (str(b.thinking)?.length ?? 0), 0);

// ---------------------------------------------------------------------------
// known traps — encoded so the next reader does not rediscover them
// ---------------------------------------------------------------------------

export const TRAPS = [
  {
    id: "per-block-record-duplication",
    severity: "critical",
    what: "One API response is written as one record per content block, each repeating the full message.usage.",
    detect:
      "count(assistant records) / count(distinct message.id) — was 2.36 on the July 2026 corpus",
    fix: "Group by billingKey(); take one member per group.",
  },
  {
    id: "subagent-files-missed",
    severity: "critical",
    what: "Subagent + workflow transcripts live in <sessionId>/subagents/**, not <sessionId>.jsonl.",
    detect: "Compare a recursive walk to a `<slug>/*.jsonl` glob — 477 files vs 109 here.",
    fix: "Walk the project dir recursively; tag each file with its kind.",
  },
  {
    id: "fallback-iteration-dropped",
    severity: "high",
    what: "On model fallback, top-level message.usage reflects only the final attempt; the discarded cheaper attempt is billed but only visible in message.usage.iterations[].",
    detect: 'assistant records where iterations[].type includes "fallback_message"',
    fix: "Price over billableUnits(), never over top-level usage alone.",
  },
  {
    id: "no-cost-field",
    severity: "high",
    what: "There is NO costUSD/total_cost_usd anywhere in the transcript. Cost is always derived.",
    detect: "grep costUSD ~/.claude/projects — zero hits.",
    fix: "Carry an explicit, versioned pricing table; record which table version produced a number.",
  },
  {
    id: "synthetic-model",
    severity: "medium",
    what: 'model can be "<synthetic>" for locally generated messages that never hit the API.',
    fix: "Skip UNPRICED_MODELS before pricing.",
  },
  {
    id: "model-variant-suffix",
    severity: "medium",
    what: "Model ids can carry a bracketed variant, e.g. claude-opus-4-8[1m] (1M context), priced differently.",
    fix: "splitModel() before pricing lookup; price the variant, do not silently strip it.",
  },
  {
    id: "fork-copies-the-prefix",
    severity: "critical",
    what:
      "Resuming or forking a session COPIES the inherited transcript prefix into the new " +
      "session's file, preserving uuid / timestamp / requestId / message.id. The same billed " +
      "turn therefore exists in 2+ files (5.5% of message.ids here, chains up to 4 deep). " +
      "Per-file or per-session summing double-counts; only a GLOBAL dedup is correct.",
    detect: "count message.ids appearing in more than one file",
    fix: "Dedup by billingKey() across the whole corpus, then attribute via originSession().",
  },
  {
    id: "session-id-is-provenance-not-a-rename",
    severity: "high",
    what:
      "sessionId and session_id are NOT a naming migration. On a copied record sessionId is " +
      "rewritten to the CONTAINING session while session_id keeps the ORIGINATING one — it is " +
      "the fork-provenance field. (`slug` is nulled on copies.) Introduced in Claude Code " +
      "2.1.199; absent before, which is the whole reason its presence is ~78%.",
    detect: "records where session_id !== sessionId are inherited, not native",
    fix: "isInherited() / originSession(); never treat session_id as an alias of sessionId.",
  },
  {
    id: "sessionid-vs-file",
    severity: "medium",
    what: "A record's sessionId field can differ from the filename it lives in (resumed / forked / relocated sessions).",
    detect: "record:relocated and record:fork-context-ref exist.",
    fix: "Keep both: fileSessionId (provenance) and recordSessionId (logical).",
  },
];
