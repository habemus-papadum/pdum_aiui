/**
 * The normalizer: raw JSONL records → the five analytic grains.
 *
 * This is where every trap in `fields.ts` is actually paid off. The order of
 * operations is load-bearing:
 *
 *   1. **Collect** every assistant record across the WHOLE corpus, keyed by
 *      `billingKey()`. Not per file, not per session — forking copies billed
 *      turns into sibling files, so anything narrower double-counts.
 *   2. **Choose** one record per key (`preferOriginal`: a sidechain replay
 *      loses to the parent's own copy).
 *   3. **Attribute** each surviving turn to `originSession()`, so a fork is
 *      credited to the session that actually produced the turn.
 *   4. **Price** over `billableUnits()` — the iterations ledger — never over
 *      top-level usage, which drops discarded fallback attempts.
 *
 * The invariant worth asserting: `SUM(sessions.nativeCost) === corpus total`.
 * `checkInvariants()` does exactly that, and the CLI runs it every time.
 */

import type { Rec } from "./fields.ts";
import {
  agentIdentity,
  arr,
  billableUnits,
  billingKey,
  blockTypes,
  compaction,
  fallbackEvent,
  get,
  hadFallback,
  isInherited,
  isWasted,
  num,
  obj,
  originSession,
  preferForBilling,
  splitModel,
  str,
  thinkingChars,
  toolOutcome,
  toolUses,
  totalOutput,
  UNPRICED_MODELS,
} from "./fields.ts";
import { imageRefs } from "./images.ts";
import type { PriceTable } from "./pricing.ts";
import { priceUnit } from "./pricing.ts";
import type { FileKind, TranscriptFile } from "./scan.ts";
import { projectLabel, repoRoot } from "./scan.ts";

// ---------------------------------------------------------------------------
// row shapes — these ARE the contract; everything downstream queries them
// ---------------------------------------------------------------------------

export interface TurnRow {
  messageId: string;
  requestId?: string;
  /** The session that produced (and paid for) this turn. */
  sessionId: string;
  /** The file this copy was read from — may differ after a fork. */
  fileSessionId: string;
  projectSlug: string;
  project: string;
  cwd?: string;
  gitBranch?: string;
  ts: number;
  model?: string;
  modelVariant?: string;
  effort?: string;
  stopReason?: string;
  serviceTier?: string;
  speed?: string;
  /** `main` | `subagent` | `workflow-agent` — where the turn executed. */
  context: string;
  agentId?: string;
  agentType?: string;
  entrypoint?: string;
  sessionKind?: string;
  ccVersion?: string;
  attributionSkill?: string;
  attributionPlugin?: string;
  attributionMcpServer?: string;
  attributionMcpTool?: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreate5m: number;
  cacheCreate1h: number;
  cacheReadTokens: number;
  webSearches: number;
  webFetches: number;
  hadFallback: boolean;
  /** Output tokens billed for an attempt that was thrown away. */
  wastedOutputTokens: number;
  nBlocks: number;
  nThinkingChars: number;
  nToolUses: number;
  nImages: number;
  estImageTokens: number;
  aborted: boolean;
  costInput: number;
  costOutput: number;
  costCacheCreate: number;
  costCacheRead: number;
  costTotal: number;
  pricingVersion: string;
  /** True when no price entry matched — cost columns are zero, not free. */
  unpriced: boolean;
}

export interface ToolCallRow {
  messageId: string;
  toolUseId?: string;
  sessionId: string;
  ts: number;
  toolName: string;
  isMcp: boolean;
  mcpServer?: string;
  context: string;
  ok?: boolean;
  interrupted?: boolean;
  errorKind?: string;
  exitCode?: number;
  durationMs?: number;
}

export interface EventRow {
  ts: number;
  sessionId: string;
  projectSlug: string;
  kind: string;
  /** Deliberately untyped JSON — this is where new CC features land first. */
  payload: string;
}

export interface SessionRow {
  sessionId: string;
  projectSlug: string;
  project: string;
  cwd?: string;
  slug?: string;
  firstTs: number;
  lastTs: number;
  spanSeconds: number;
  activeSeconds: number;
  dutyCycle: number;
  nTurnsNative: number;
  nSubagentTurns: number;
  nCompactions: number;
  peakContextTokens: number;
  /** Only this sums. Inherited turns belong to an ancestor. */
  nativeCost: number;
  models: string;
  ccVersions: string;
}

export interface ImageRow {
  /**
   * The *user record's* uuid, not a `msg_…` id — user records carry no
   * `message.id`. Distinct images are identified by `hash`, not by this: the
   * `tool_result` and `toolUseResult` carriers are two views of one payload, so
   * 362 rows here are 276 distinct images.
   */
  uuid: string;
  sessionId: string;
  ts: number;
  carrier: string;
  mediaType?: string;
  width?: number;
  height?: number;
  bytesBase64: number;
  estTokens: number;
  hash: string;
}

export interface Normalized {
  turns: TurnRow[];
  toolCalls: ToolCallRow[];
  events: EventRow[];
  sessions: SessionRow[];
  images: ImageRow[];
  stats: NormalizeStats;
}

export interface NormalizeStats {
  files: number;
  bytes: number;
  records: number;
  parseErrors: number;
  assistantRecords: number;
  dedupedTurns: number;
  /** How much a naive per-record sum would have overstated output tokens. */
  naiveOutputTokens: number;
  dedupedOutputTokens: number;
  inheritedTurnsSeen: number;
  crossFileDuplicates: number;
  unpricedTurns: number;
  /** Data-quality observation, not a pipeline fault — see checkInvariants. */
  turnsWithoutTimestamp: number;
  /**
   * Billing groups whose members disagreed on output_tokens. Surfaced because
   * this is the regime where `preferForBilling` is load-bearing: if a refactor
   * ever reverted to "keep the first member", output would silently drop by
   * roughly this population's share. A non-zero value here is normal (subagent
   * transcripts), a zero value on a corpus with subagents is suspicious.
   */
  groupsWithVaryingOutput: number;
  totalCost: number;
  pricingVersion: string;
}

/** One API response: the chosen record for usage, the union of all structure. */
interface BilledTurn {
  rec: Rec;
  file: TranscriptFile;
  uuids: Set<string>;
  blocks: number;
  toolUses: ReturnType<typeof toolUses>;
  thinkingChars: number;
}

/** Gap above which a session is considered idle rather than working. */
export const DEFAULT_IDLE_GAP_SECONDS = 30 * 60;

const tsOf = (rec: Rec): number => {
  const t = str(rec.timestamp);
  if (!t) return 0;
  const n = Date.parse(t);
  return Number.isFinite(n) ? n : 0;
};

const contextOf = (kind: FileKind): string =>
  kind === "session" ? "main" : kind === "workflow-journal" ? "workflow-journal" : kind;

// ---------------------------------------------------------------------------
// the accumulator
// ---------------------------------------------------------------------------

export interface NormalizeOptions {
  pricing: PriceTable;
  idleGapSeconds?: number;
  /** Skip image header decoding — much faster when images are not the question. */
  skipImages?: boolean;
}

export class Normalizer {
  private readonly opts: Required<Omit<NormalizeOptions, "pricing">> & { pricing: PriceTable };
  /**
   * billingKey → the winning record (for usage + envelope) PLUS the structure
   * unioned across every record sharing that key.
   *
   * The subtlety that cost a bug: usage is *duplicated* across a response's
   * per-block records, but content is *partitioned* across them. Deduping for
   * billing and deduping for structure are different operations — take one
   * record's usage, but every record's blocks. `uuids` guards the union against
   * fork copies, which repeat the same uuid in a sibling file.
   */
  private readonly billed = new Map<string, BilledTurn>();
  /** messageId → set of files, purely to measure fork duplication. */
  private readonly seenIn = new Map<string, Set<string>>();
  private readonly toolResults = new Map<string, Rec>();
  /**
   * Images ride on USER records, not assistant ones, so they are collected on
   * their own pass rather than off the back of a turn. Keyed by record uuid so
   * a fork copy of the same paste is not counted twice.
   */
  private readonly imagesByUuid = new Map<string, ImageRow[]>();
  private readonly events: EventRow[] = [];
  /**
   * projectSlug → the shortest repo root seen under it.
   *
   * A turn's own `cwd` is the wrong thing to label a project with: a subagent
   * may run in `<repo>/packages/foo` or in a `.claude/worktrees/agent-<id>`
   * isolation worktree, which split one repository into dozens of "projects"
   * (108 labels for 18 repos before this). The shortest root under a slug is
   * the repository itself, and every turn under that slug inherits it.
   */
  private readonly slugRoot = new Map<string, string>();
  /** sessionId → per-session running facts that do not come from turns. */
  private readonly sessionMeta = new Map<
    string,
    { slug?: string; cwd?: string; projectSlug: string; compactions: number; peakContext: number }
  >();
  readonly stats: NormalizeStats;

  constructor(options: NormalizeOptions) {
    this.opts = {
      pricing: options.pricing,
      idleGapSeconds: options.idleGapSeconds ?? DEFAULT_IDLE_GAP_SECONDS,
      skipImages: options.skipImages ?? false,
    };
    this.stats = {
      files: 0,
      bytes: 0,
      records: 0,
      parseErrors: 0,
      assistantRecords: 0,
      dedupedTurns: 0,
      naiveOutputTokens: 0,
      dedupedOutputTokens: 0,
      inheritedTurnsSeen: 0,
      crossFileDuplicates: 0,
      unpricedTurns: 0,
      turnsWithoutTimestamp: 0,
      groupsWithVaryingOutput: 0,
      totalCost: 0,
      pricingVersion: options.pricing.version,
    };
  }

  noteFile(file: TranscriptFile): void {
    this.stats.files++;
    this.stats.bytes += file.bytes;
  }

  noteParseError(): void {
    this.stats.parseErrors++;
  }

  /** Feed one record. Order within a file matters; order across files does not. */
  add(rec: Rec, file: TranscriptFile): void {
    this.stats.records++;
    const cwd = str(rec.cwd);
    if (cwd) {
      const root = repoRoot(cwd);
      const known = this.slugRoot.get(file.projectSlug);
      if (known === undefined || root.length < known.length) {
        this.slugRoot.set(file.projectSlug, root);
      }
    }
    const type = str(rec.type);

    if (type === "assistant") {
      this.stats.assistantRecords++;
      this.stats.naiveOutputTokens += num(get(rec, "message.usage.output_tokens"));
      if (isInherited(rec)) this.stats.inheritedTurnsSeen++;

      const mid = str(get(rec, "message.id"));
      if (mid) {
        let files = this.seenIn.get(mid);
        if (!files) {
          files = new Set();
          this.seenIn.set(mid, files);
        }
        files.add(file.path);
      }

      const key = billingKey(rec);
      if (key) {
        let entry = this.billed.get(key);
        if (!entry) {
          entry = { rec, file, uuids: new Set(), blocks: 0, toolUses: [], thinkingChars: 0 };
          this.billed.set(key, entry);
        } else {
          // NOT "keep the first". A group's members disagree on output_tokens
          // (see fields.ts preferForBilling) — the final record carries the real
          // count. Ties fall through to the non-sidechain copy, which settles
          // fork duplicates.
          const before = totalOutput(entry.rec);
          entry.rec = preferForBilling(entry.rec, rec);
          if (totalOutput(entry.rec) !== before) this.stats.groupsWithVaryingOutput++;
        }
        const uuid = str(rec.uuid);
        // A fork copies whole records; without this guard its blocks would be
        // unioned in a second time and inflate nToolUses / nBlocks.
        if (!uuid || !entry.uuids.has(uuid)) {
          if (uuid) entry.uuids.add(uuid);
          entry.blocks += blockTypes(rec).length;
          entry.toolUses.push(...toolUses(rec));
          entry.thinkingChars += thinkingChars(rec);
        }
      }
      this.recordSessionMeta(rec, file);
      return;
    }

    if (type === "user") {
      // Tool results live on user records and are joined to their tool_use by id.
      for (const block of arr(get(rec, "message.content"))) {
        const b = obj(block);
        if (b?.type === "tool_result") {
          const id = str(b.tool_use_id);
          if (id) this.toolResults.set(id, rec);
        }
      }
      if (!this.opts.skipImages) this.collectImages(rec, file);
      this.recordSessionMeta(rec, file);
      return;
    }

    if (type === "system") {
      const sid = originSession(rec) ?? file.fileSessionId;
      const c = compaction(rec);
      if (c) {
        const meta = this.metaFor(sid, file);
        meta.compactions++;
        meta.peakContext = Math.max(meta.peakContext, c.preTokens);
        this.events.push({
          ts: tsOf(rec),
          sessionId: sid,
          projectSlug: file.projectSlug,
          kind: "compaction",
          payload: JSON.stringify(c),
        });
      }
      const fb = fallbackEvent(rec);
      if (fb) {
        this.events.push({
          ts: tsOf(rec),
          sessionId: sid,
          projectSlug: file.projectSlug,
          kind: "fallback",
          payload: JSON.stringify(fb),
        });
      }
      const refusal = str(rec.apiRefusalCategory);
      if (refusal) {
        this.events.push({
          ts: tsOf(rec),
          sessionId: sid,
          projectSlug: file.projectSlug,
          kind: "refusal",
          payload: JSON.stringify({ category: refusal, uuid: str(rec.refusedUserMessageUuid) }),
        });
      }
      return;
    }

    if (type === "relocated" || type === "fork-context-ref" || type === "pr-link") {
      this.events.push({
        ts: tsOf(rec),
        sessionId: originSession(rec) ?? file.fileSessionId,
        projectSlug: file.projectSlug,
        kind: type,
        payload: JSON.stringify(rec),
      });
    }
  }

  /** Harvest image payloads off a user record, once per distinct record uuid. */
  private collectImages(rec: Rec, file: TranscriptFile): void {
    const uuid = str(rec.uuid);
    if (uuid && this.imagesByUuid.has(uuid)) return; // fork copy of the same paste
    const refs = imageRefs(rec);
    if (refs.length === 0) return;
    const sessionId = originSession(rec) ?? file.fileSessionId;
    const ts = tsOf(rec);
    const rows = refs.map((i) => ({
      uuid: uuid ?? "",
      sessionId,
      ts,
      carrier: i.carrier,
      mediaType: i.mediaType,
      width: i.width,
      height: i.height,
      bytesBase64: i.base64Length,
      estTokens: i.estTokens ?? 0,
      hash: i.hash,
    }));
    this.imagesByUuid.set(uuid ?? `${sessionId}:${ts}:${rows[0].hash}`, rows);
  }

  private metaFor(sessionId: string, file: TranscriptFile) {
    let m = this.sessionMeta.get(sessionId);
    if (!m) {
      m = { projectSlug: file.projectSlug, compactions: 0, peakContext: 0 };
      this.sessionMeta.set(sessionId, m);
    }
    return m;
  }

  private recordSessionMeta(rec: Rec, file: TranscriptFile): void {
    const sid = originSession(rec);
    if (!sid) return;
    const m = this.metaFor(sid, file);
    // Only a native record describes its own session: on a fork copy `slug` is
    // nulled and `cwd` belongs to wherever the original ran.
    if (!isInherited(rec)) {
      m.slug ??= str(rec.slug);
      m.cwd ??= str(rec.cwd);
    }
  }

  /** Collapse everything collected into the five grains. */
  finish(): Normalized {
    const turns: TurnRow[] = [];
    const toolCalls: ToolCallRow[] = [];
    const images: ImageRow[] = [];

    for (const [, entry] of this.billed) {
      const row = this.turnRow(entry);
      if (!row) continue;
      turns.push(row);
      this.stats.dedupedOutputTokens += row.outputTokens;
      this.stats.totalCost += row.costTotal;
      if (row.unpriced) this.stats.unpricedTurns++;
      if (!row.ts) this.stats.turnsWithoutTimestamp++;
      toolCalls.push(...this.toolCallRows(entry, row));
    }
    for (const rows of this.imagesByUuid.values()) images.push(...rows);

    this.stats.dedupedTurns = turns.length;
    for (const files of this.seenIn.values()) {
      if (files.size > 1) this.stats.crossFileDuplicates++;
    }

    turns.sort((a, b) => a.ts - b.ts);
    toolCalls.sort((a, b) => a.ts - b.ts);
    images.sort((a, b) => a.ts - b.ts);
    this.events.sort((a, b) => a.ts - b.ts);

    return {
      turns,
      toolCalls,
      events: this.events,
      images,
      sessions: this.sessionRows(turns),
      stats: this.stats,
    };
  }

  private turnRow(entry: BilledTurn): TurnRow | undefined {
    const { rec, file } = entry;
    const messageId = str(get(rec, "message.id"));
    if (!messageId) return undefined;
    const units = billableUnits(rec);
    const model = str(get(rec, "message.model"));
    const { variant } = splitModel(model);

    let inputTokens = 0;
    let outputTokens = 0;
    let cacheCreate5m = 0;
    let cacheCreate1h = 0;
    let cacheReadTokens = 0;
    let webSearches = 0;
    let webFetches = 0;
    let wastedOutputTokens = 0;
    let costInput = 0;
    let costOutput = 0;
    let costCacheCreate = 0;
    let costCacheRead = 0;
    let priceable = 0;
    let priced = 0;

    const fellBack = hadFallback(rec);
    for (const u of units) {
      // A discarded fallback attempt is billed but is not the "real" turn's
      // usage; count its tokens under wasted* and still price them.
      if (fellBack && u.iterationType !== "fallback_message") wastedOutputTokens += u.output;
      inputTokens += u.input;
      outputTokens += u.output;
      cacheCreate5m += u.cache5m;
      cacheCreate1h += u.cache1h;
      // Older builds have no TTL split; keep those tokens visible under 5m.
      if (u.cache5m + u.cache1h === 0) cacheCreate5m += u.cacheCreate;
      cacheReadTokens += u.cacheRead;
      webSearches += u.webSearches;
      webFetches += u.webFetches;

      if (!u.model || UNPRICED_MODELS.has(u.model)) continue;
      priceable++;
      const p = priceUnit(this.opts.pricing, u);
      if (!p) continue;
      priced++;
      costInput += p.input;
      costOutput += p.output;
      costCacheCreate += p.cacheCreate;
      costCacheRead += p.cacheRead;
    }

    const agent = agentIdentity(rec);

    return {
      messageId,
      requestId: str(rec.requestId),
      sessionId: originSession(rec) ?? file.fileSessionId,
      fileSessionId: file.fileSessionId,
      projectSlug: file.projectSlug,
      project: projectLabel(file.projectSlug, this.slugRoot.get(file.projectSlug) ?? str(rec.cwd)),
      cwd: str(rec.cwd),
      gitBranch: str(rec.gitBranch),
      ts: tsOf(rec),
      model,
      modelVariant: variant,
      effort: str(rec.effort),
      stopReason: str(get(rec, "message.stop_reason")),
      serviceTier: str(get(rec, "message.usage.service_tier")),
      speed: str(get(rec, "message.usage.speed")),
      context: contextOf(file.kind),
      agentId: agent?.agentId,
      agentType: agent?.agentType,
      entrypoint: str(rec.entrypoint),
      sessionKind: str(rec.sessionKind),
      ccVersion: str(rec.version),
      attributionSkill: str(rec.attributionSkill),
      attributionPlugin: str(rec.attributionPlugin),
      attributionMcpServer: str(rec.attributionMcpServer),
      attributionMcpTool: str(rec.attributionMcpTool),
      inputTokens,
      outputTokens,
      cacheCreate5m,
      cacheCreate1h,
      cacheReadTokens,
      webSearches,
      webFetches,
      hadFallback: fellBack,
      wastedOutputTokens,
      // Unioned across the response's per-block records, not read off one.
      nBlocks: entry.blocks,
      nThinkingChars: entry.thinkingChars,
      nToolUses: entry.toolUses.length,
      // Images belong to user turns; a turn row counts none of its own.
      nImages: 0,
      estImageTokens: 0,
      aborted: isWasted(rec),
      costInput,
      costOutput,
      costCacheCreate,
      costCacheRead,
      costTotal: costInput + costOutput + costCacheCreate + costCacheRead,
      pricingVersion: this.opts.pricing.version,
      unpriced: priceable > 0 && priced === 0,
    };
  }

  private toolCallRows(entry: BilledTurn, turn: TurnRow): ToolCallRow[] {
    return entry.toolUses.map((t) => {
      const name = t.name ?? "<unnamed>";
      const isMcp = name.startsWith("mcp__");
      const result = t.id ? this.toolResults.get(t.id) : undefined;
      const outcome = result ? toolOutcome(result) : undefined;
      return {
        messageId: turn.messageId,
        toolUseId: t.id,
        sessionId: turn.sessionId,
        ts: turn.ts,
        toolName: name,
        isMcp,
        mcpServer: isMcp ? name.split("__")[1] : undefined,
        context: turn.context,
        ok: outcome?.ok,
        interrupted: outcome?.interrupted,
        errorKind: outcome?.error ? outcome.error.slice(0, 120) : undefined,
        exitCode: outcome?.exitCode,
        durationMs: outcome?.durationMs,
      };
    });
  }

  /**
   * Sessions are derived from the deduped turns, so a fork contributes only the
   * turns it actually produced. `activeSeconds` sums inter-turn gaps below the
   * idle threshold — computed over native turns only, or a fork would inherit
   * its ancestor's elapsed time and report a nonsense duty cycle.
   */
  private sessionRows(turns: TurnRow[]): SessionRow[] {
    const bySession = new Map<string, TurnRow[]>();
    for (const t of turns) {
      const list = bySession.get(t.sessionId);
      if (list) list.push(t);
      else bySession.set(t.sessionId, [t]);
    }
    const gapMs = this.opts.idleGapSeconds * 1000;
    const rows: SessionRow[] = [];
    for (const [sessionId, list] of bySession) {
      list.sort((a, b) => a.ts - b.ts);
      const meta = this.sessionMeta.get(sessionId);
      const firstTs = list[0].ts;
      const lastTs = list[list.length - 1].ts;
      let activeMs = 0;
      for (let i = 1; i < list.length; i++) {
        const d = list[i].ts - list[i - 1].ts;
        if (d > 0 && d < gapMs) activeMs += d;
      }
      const spanSeconds = Math.max(0, (lastTs - firstTs) / 1000);
      const activeSeconds = activeMs / 1000;
      const models = new Set<string>();
      const versions = new Set<string>();
      let nativeCost = 0;
      let nSubagentTurns = 0;
      let peakContext = meta?.peakContext ?? 0;
      for (const t of list) {
        if (t.model) models.add(t.model);
        if (t.ccVersion) versions.add(t.ccVersion);
        nativeCost += t.costTotal;
        if (t.context !== "main") nSubagentTurns++;
        // cache_read is the prefix that was re-sent — a good proxy for context
        // size at that turn. Validated against compactMetadata.preTokens.
        peakContext = Math.max(peakContext, t.cacheReadTokens);
      }
      rows.push({
        sessionId,
        projectSlug: meta?.projectSlug ?? list[0].projectSlug,
        project: list[0].project,
        cwd: meta?.cwd ?? list[0].cwd,
        slug: meta?.slug,
        firstTs,
        lastTs,
        spanSeconds,
        activeSeconds,
        dutyCycle: spanSeconds > 0 ? activeSeconds / spanSeconds : 1,
        nTurnsNative: list.length,
        nSubagentTurns,
        nCompactions: meta?.compactions ?? 0,
        peakContextTokens: peakContext,
        nativeCost,
        models: [...models].sort().join(","),
        ccVersions: [...versions].sort().join(","),
      });
    }
    rows.sort((a, b) => a.firstTs - b.firstTs);
    return rows;
  }
}

export interface InvariantResult {
  ok: boolean;
  problems: string[];
}

/**
 * The checks that would catch a regression in the dedup/attribution path.
 * Cheap enough to run on every normalize, and the CLI does.
 *
 * Deliberately scoped to *our* faults — double-counting, lost attribution,
 * dedup running backwards. Upstream malformation (a record with no timestamp,
 * a usage blob that is a string) is counted in `stats`, not failed here: the
 * whole premise of this package is that it survives whatever Claude Code
 * writes, so malformed input must not be reported as a broken pipeline.
 */
export function checkInvariants(n: Normalized): InvariantResult {
  const problems: string[] = [];
  const eps = 1e-6;

  const turnTotal = n.turns.reduce((s, t) => s + t.costTotal, 0);
  const sessionTotal = n.sessions.reduce((s, r) => s + r.nativeCost, 0);
  if (Math.abs(turnTotal - sessionTotal) > Math.max(eps, turnTotal * 1e-9)) {
    problems.push(
      `SUM(sessions.nativeCost)=${sessionTotal} != SUM(turns.costTotal)=${turnTotal} — ` +
        "a turn was attributed to no session, or double-counted.",
    );
  }

  const ids = new Set<string>();
  for (const t of n.turns) {
    const k = `${t.messageId} ${t.requestId ?? ""}`;
    if (ids.has(k)) problems.push(`duplicate billing key survived dedup: ${t.messageId}`);
    ids.add(k);
  }

  if (n.stats.dedupedOutputTokens > n.stats.naiveOutputTokens) {
    problems.push(
      "deduped output exceeds the naive sum — dedup is adding tokens, not removing them.",
    );
  }

  return { ok: problems.length === 0, problems };
}
