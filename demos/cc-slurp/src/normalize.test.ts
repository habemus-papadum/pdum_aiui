/**
 * These tests pin the four traps from `fields.ts`. Each one is a bug that was
 * either found in a real corpus or shipped in this package and caught later —
 * so each fixture is a miniature of the real failure, not a hypothetical.
 */

import { describe, expect, it } from "vitest";
import { billableUnits, billingKey, isInherited, originSession, splitModel } from "./fields.ts";
import { estimateImageTokens, imageDims, pngDims } from "./images.ts";
import { checkInvariants, Normalizer } from "./normalize.ts";
import type { PriceTable } from "./pricing.ts";
import { priceUnit } from "./pricing.ts";
import type { TranscriptFile } from "./scan.ts";
import { projectLabel } from "./scan.ts";

const PRICES: PriceTable = {
  version: "test",
  source: "litellm",
  entries: {
    "model-a": {
      input_cost_per_token: 1e-6,
      output_cost_per_token: 10e-6,
      cache_creation_input_token_cost: 2e-6,
      cache_creation_input_token_cost_above_1hr: 3.2e-6,
      cache_read_input_token_cost: 0.1e-6,
    },
    "model-b": { input_cost_per_token: 5e-6, output_cost_per_token: 50e-6 },
  },
};

const FILE = (sessionId: string, kind: TranscriptFile["kind"] = "session"): TranscriptFile => ({
  path: `/x/${sessionId}${kind === "session" ? ".jsonl" : "/subagents/a.jsonl"}`,
  projectSlug: "-Users-x-proj",
  fileSessionId: sessionId,
  kind,
  bytes: 0,
});

const usage = (o: Partial<Record<string, number>> = {}) => ({
  input_tokens: o.input ?? 10,
  output_tokens: o.output ?? 100,
  cache_creation_input_tokens: (o.c5 ?? 0) + (o.c1 ?? 0),
  cache_read_input_tokens: o.cr ?? 0,
  cache_creation: {
    ephemeral_5m_input_tokens: o.c5 ?? 0,
    ephemeral_1h_input_tokens: o.c1 ?? 0,
  },
});

/** One assistant record — the per-block shape Claude Code actually writes. */
const assistantRec = (o: {
  id: string;
  uuid: string;
  session: string;
  originSession?: string;
  block?: unknown;
  req?: string;
  usageOverride?: unknown;
  model?: string;
  ts?: string;
}) => ({
  type: "assistant",
  uuid: o.uuid,
  requestId: o.req ?? `req_${o.id}`,
  sessionId: o.session,
  ...(o.originSession ? { session_id: o.originSession } : {}),
  timestamp: o.ts ?? "2026-07-01T00:00:00.000Z",
  cwd: "/Users/x/proj",
  version: "2.1.220",
  message: {
    id: o.id,
    model: o.model ?? "model-a",
    stop_reason: "end_turn",
    content: [o.block ?? { type: "text", text: "hi" }],
    usage: o.usageOverride ?? usage(),
  },
});

describe("trap: per-block record duplication", () => {
  it("counts one response's usage once, but unions its content blocks", () => {
    const n = new Normalizer({ pricing: PRICES });
    const f = FILE("s1");
    // ONE API response, written as THREE records, each repeating the usage.
    n.add(
      assistantRec({
        id: "m1",
        uuid: "u1",
        session: "s1",
        block: { type: "thinking", thinking: "abcd" },
      }),
      f,
    );
    n.add(
      assistantRec({ id: "m1", uuid: "u2", session: "s1", block: { type: "text", text: "hello" } }),
      f,
    );
    n.add(
      assistantRec({
        id: "m1",
        uuid: "u3",
        session: "s1",
        block: { type: "tool_use", id: "t1", name: "Bash", input: {} },
      }),
      f,
    );
    const out = n.finish();

    expect(out.turns).toHaveLength(1);
    // usage counted ONCE, not three times
    expect(out.turns[0].outputTokens).toBe(100);
    // ...but every block survives — dedup for billing must not dedup structure
    expect(out.turns[0].nBlocks).toBe(3);
    expect(out.turns[0].nThinkingChars).toBe(4);
    expect(out.turns[0].nToolUses).toBe(1);
    expect(out.toolCalls).toHaveLength(1);
    expect(out.toolCalls[0].toolName).toBe("Bash");
  });
});

describe("trap: partial usage inside a billing group", () => {
  it("takes the member with the real output, not the first one", () => {
    // The exact shape found in subagent transcripts: cache_read constant across
    // the group, output_tokens a placeholder until the final record.
    const n = new Normalizer({ pricing: PRICES });
    const f = FILE("s1", "subagent");
    const partial = (uuid: string, out: number, block: unknown) =>
      assistantRec({
        id: "m1",
        uuid,
        session: "s1",
        block,
        usageOverride: {
          input_tokens: 3,
          output_tokens: out,
          cache_read_input_tokens: 156614,
          cache_creation_input_tokens: 0,
          cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
        },
      });
    n.add(partial("u1", 5, { type: "thinking", thinking: "x" }), f);
    n.add(partial("u2", 5, { type: "text", text: "y" }), f);
    n.add(partial("u3", 48469, { type: "tool_use", id: "t1", name: "Bash", input: {} }), f);

    const out = n.finish();
    expect(out.turns).toHaveLength(1);
    // 48469, not 5 — taking the first member undercounted output by 32% corpus-wide
    expect(out.turns[0].outputTokens).toBe(48469);
    // the constant classes are unaffected, whichever member is chosen
    expect(out.turns[0].cacheReadTokens).toBe(156614);
    // structure is still unioned across all three records
    expect(out.turns[0].nBlocks).toBe(3);
    expect(out.toolCalls).toHaveLength(1);
  });

  it("still prefers the non-sidechain copy when output ties (fork case)", () => {
    const n = new Normalizer({ pricing: PRICES });
    n.add(assistantRec({ id: "m1", uuid: "u1", session: "s1", originSession: "s1" }), FILE("s1"));
    n.add(
      assistantRec({ id: "m1", uuid: "u1", session: "s2", originSession: "s1" }),
      FILE("s2", "subagent"),
    );
    const out = n.finish();
    expect(out.turns).toHaveLength(1);
    // attributed to the session that produced it, not the file it was copied into
    expect(out.turns[0].sessionId).toBe("s1");
  });
});

describe("trap: fork copies the prefix", () => {
  it("counts a turn once when it appears in two session files", () => {
    const n = new Normalizer({ pricing: PRICES });
    // The original, in its own session.
    n.add(assistantRec({ id: "m1", uuid: "u1", session: "s1", originSession: "s1" }), FILE("s1"));
    // The fork's copy: same uuid/message.id, sessionId rewritten, session_id kept.
    n.add(assistantRec({ id: "m1", uuid: "u1", session: "s2", originSession: "s1" }), FILE("s2"));
    // A turn the fork actually produced.
    n.add(assistantRec({ id: "m2", uuid: "u2", session: "s2", originSession: "s2" }), FILE("s2"));

    const out = n.finish();
    expect(out.turns).toHaveLength(2);
    expect(out.stats.crossFileDuplicates).toBe(1);

    // The inherited turn is credited to s1, which produced it — not to s2.
    const bySession = new Map(out.sessions.map((s) => [s.sessionId, s]));
    expect(bySession.get("s1")?.nTurnsNative).toBe(1);
    expect(bySession.get("s2")?.nTurnsNative).toBe(1);
    expect(checkInvariants(out).ok).toBe(true);
  });

  it("does not double-count a fork copy's content blocks", () => {
    const n = new Normalizer({ pricing: PRICES });
    const block = { type: "tool_use", id: "t1", name: "Read", input: {} };
    n.add(assistantRec({ id: "m1", uuid: "u1", session: "s1", block }), FILE("s1"));
    n.add(
      assistantRec({ id: "m1", uuid: "u1", session: "s2", originSession: "s1", block }),
      FILE("s2"),
    );
    const out = n.finish();
    expect(out.turns[0].nToolUses).toBe(1);
    expect(out.toolCalls).toHaveLength(1);
  });

  it("reads session_id as provenance, not as an alias of sessionId", () => {
    expect(isInherited({ sessionId: "b", session_id: "a" })).toBe(true);
    expect(isInherited({ sessionId: "a", session_id: "a" })).toBe(false);
    // Pre-2.1.199 records have no session_id at all — not decidable, not inherited.
    expect(isInherited({ sessionId: "a" })).toBe(false);
    expect(originSession({ sessionId: "b", session_id: "a" })).toBe("a");
    expect(originSession({ sessionId: "b" })).toBe("b");
  });
});

describe("trap: fallback iterations", () => {
  it("prices the discarded attempt, which top-level usage omits", () => {
    const rec = assistantRec({
      id: "m1",
      uuid: "u1",
      session: "s1",
      model: "model-b",
      usageOverride: {
        ...usage({ output: 5000 }),
        // top level reflects only the LAST attempt…
        iterations: [
          { type: "message", model: "model-a", input_tokens: 10, output_tokens: 250 },
          { type: "fallback_message", model: "model-b", input_tokens: 10, output_tokens: 5000 },
        ],
      },
    });
    const units = billableUnits(rec);
    expect(units).toHaveLength(2);
    expect(units[0].model).toBe("model-a");
    expect(units[1].model).toBe("model-b");

    const n = new Normalizer({ pricing: PRICES });
    n.add(rec, FILE("s1"));
    const out = n.finish();
    // 250 + 5000, not just the 5000 the top level advertises
    expect(out.turns[0].outputTokens).toBe(5250);
    expect(out.turns[0].hadFallback).toBe(true);
    expect(out.turns[0].wastedOutputTokens).toBe(250);
  });
});

describe("pricing", () => {
  it("charges the 1h cache tier above the 5m rate", () => {
    const flat = priceUnit(PRICES, {
      model: "model-a",
      input: 0,
      output: 0,
      cacheCreate: 1000,
      cacheRead: 0,
      cache5m: 1000,
      cache1h: 0,
      webSearches: 0,
      webFetches: 0,
    });
    const tiered = priceUnit(PRICES, {
      model: "model-a",
      input: 0,
      output: 0,
      cacheCreate: 1000,
      cacheRead: 0,
      cache5m: 0,
      cache1h: 1000,
      webSearches: 0,
      webFetches: 0,
    });
    expect(flat?.cacheCreate).toBeCloseTo(0.002);
    expect(tiered?.cacheCreate).toBeCloseTo(0.0032);
    // The 1.6x gap is the whole reason this package does not use genai-prices.
    expect((tiered?.cacheCreate ?? 0) / (flat?.cacheCreate ?? 1)).toBeCloseTo(1.6);
  });

  it("never prices a synthetic model", () => {
    expect(
      priceUnit(PRICES, {
        model: "<synthetic>",
        input: 1e6,
        output: 1e6,
        cacheCreate: 0,
        cacheRead: 0,
        cache5m: 0,
        cache1h: 0,
        webSearches: 0,
        webFetches: 0,
      }),
    ).toBeUndefined();
  });

  it("keeps a bracketed context variant distinct from its base model", () => {
    expect(splitModel("claude-opus-4-8[1m]")).toEqual({ base: "claude-opus-4-8", variant: "1m" });
    expect(splitModel("claude-opus-4-8")).toEqual({ base: "claude-opus-4-8", variant: undefined });
  });

  it("falls back to the aggregate when a build predates the TTL split", () => {
    const n = new Normalizer({ pricing: PRICES });
    n.add(
      assistantRec({
        id: "m1",
        uuid: "u1",
        session: "s1",
        // no `cache_creation` object at all — the pre-split shape
        usageOverride: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 500 },
      }),
      FILE("s1"),
    );
    const out = n.finish();
    // Those tokens stay visible rather than vanishing into an absent TTL bucket.
    expect(out.turns[0].cacheCreate5m).toBe(500);
    expect(out.turns[0].costCacheCreate).toBeCloseTo(0.001);
  });
});

describe("billing key", () => {
  it("separates records that share a message.id but differ in requestId", () => {
    const a = billingKey({ message: { id: "m1" }, requestId: "r1" });
    const b = billingKey({ message: { id: "m1" }, requestId: "r2" });
    expect(a).not.toBe(b);
    expect(billingKey({ message: {} })).toBeUndefined();
  });
});

describe("images", () => {
  it("reads PNG dimensions from the IHDR header alone", () => {
    // 8-byte signature, then a length+"IHDR" chunk with width/height.
    const b = new Uint8Array(24);
    b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    b.set([0x49, 0x48, 0x44, 0x52], 12);
    new DataView(b.buffer).setUint32(16, 2000);
    new DataView(b.buffer).setUint32(20, 966);
    expect(pngDims(b)).toEqual({ width: 2000, height: 966 });
    expect(imageDims("image/png", b)).toEqual({ width: 2000, height: 966 });
    // Anthropic's published approximation.
    expect(estimateImageTokens({ width: 2000, height: 966 })).toBe(2576);
  });

  it("returns undefined rather than throwing on a non-image buffer", () => {
    expect(pngDims(new Uint8Array([1, 2, 3]))).toBeUndefined();
    expect(imageDims("image/png", new Uint8Array(0))).toBeUndefined();
  });
});

describe("leniency", () => {
  it("survives records that violate every expectation", () => {
    const n = new Normalizer({ pricing: PRICES });
    const f = FILE("s1");
    expect(() => {
      n.add({}, f);
      n.add({ type: "assistant" }, f);
      n.add({ type: "assistant", message: null }, f);
      n.add({ type: "assistant", message: { id: "m9", usage: "not-an-object" } }, f);
      n.add({ type: "user", toolUseResult: "a string, not an object" }, f);
      n.add({ type: "user", message: { content: "not an array" } }, f);
      n.add({ type: "system", compactMetadata: 42 }, f);
      n.add({ type: "brand-new-record-type-from-a-future-build", wat: true }, f);
    }).not.toThrow();
    const out = n.finish();
    expect(checkInvariants(out).ok).toBe(true);
  });
});

describe("sessions", () => {
  it("separates wall-clock span from active time", () => {
    const n = new Normalizer({ pricing: PRICES, idleGapSeconds: 1800 });
    const f = FILE("s1");
    // two turns a minute apart, then a 5-hour gap, then one more
    n.add(assistantRec({ id: "m1", uuid: "u1", session: "s1", ts: "2026-07-01T00:00:00.000Z" }), f);
    n.add(assistantRec({ id: "m2", uuid: "u2", session: "s1", ts: "2026-07-01T00:01:00.000Z" }), f);
    n.add(assistantRec({ id: "m3", uuid: "u3", session: "s1", ts: "2026-07-01T05:01:00.000Z" }), f);
    const [s] = n.finish().sessions;
    expect(s.spanSeconds).toBeCloseTo(5 * 3600 + 60);
    expect(s.activeSeconds).toBeCloseTo(60); // the 5h gap is idle, not work
    expect(s.dutyCycle).toBeLessThan(0.01);
  });
});

describe("project labels", () => {
  it("collapses worktrees onto the repository they belong to", () => {
    // The bug this pins: worktree-isolated subagents run in
    // <repo>/.claude/worktrees/agent-<id>, which made every subagent its own
    // project — 108 labels for 18 repos.
    expect(projectLabel("x", "/Users/n/src/pdum_rfb/.claude/worktrees/agent-ada279")).toBe(
      "pdum_rfb",
    );
    expect(projectLabel("x", "/Users/n/src/pdum_aiui/.claude/worktrees/cc-usage")).toBe(
      "pdum_aiui",
    );
    expect(projectLabel("x", "/Users/n/src/helium")).toBe("helium");
  });

  it("falls back to the slug when a record carries no cwd", () => {
    expect(projectLabel("-Users-n-src-helium")).toBe("helium");
  });
});
