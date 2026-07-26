/**
 * viewer-model.ts — the session viewer's pure model: how a hot ledger stream
 * becomes something a human can read. Deliberately NOT the trace viewer's
 * shape (that renders a finished, bounded run): a live session is
 * high-frequency and unbounded, so the units here are TURNS (a heard/injected
 * utterance and everything it caused), categories default the chatter off,
 * and detail is progressive — one line per turn, expandable to entries,
 * expandable to the entry's data.
 *
 * Pure and DOM-free so the grouping/summary logic is unit-tested without
 * rendering (the Solid plugin is off under Vitest — the house recipe).
 */

import type { OracleState } from "../session";
import type { LedgerEntry } from "../types";

/** Coarse filter categories — the viewer's chips. */
export type LedgerCategory = "turn" | "tool" | "config" | "flow" | "error" | "raw";

export const ALL_CATEGORIES: readonly LedgerCategory[] = [
  "turn",
  "tool",
  "config",
  "flow",
  "error",
  "raw",
];

/** What a debugging session wants on by default: the conversation, the
 * actions, the config record, and every error. The per-event chatter (flow)
 * and unclassified vendor payloads (raw) are opt-in detail levels. */
export function defaultCategories(): Set<LedgerCategory> {
  return new Set(["turn", "tool", "config", "error"]);
}

export function categoryOf(entry: LedgerEntry): LedgerCategory {
  switch (entry.kind) {
    case "heard":
    case "said":
    case "injected":
      return "turn";
    case "tool-call":
    case "tool-result":
      return "tool";
    case "session":
    case "config":
      return "config";
    case "speech":
    case "response":
      return "flow";
    case "error":
      return "error";
    case "raw":
      return "raw";
  }
}

/** One conversational unit: an utterance (spoken or injected) and everything
 * that followed it, up to the next utterance. */
export interface TurnGroup {
  /** The seq of the entry that opened the group (stable render key). */
  id: number;
  entries: LedgerEntry[];
}

/**
 * Group a ledger into turns. A `heard` or a user-role `injected` OPENS a new
 * group; everything else rides the current one. Entries before the first
 * utterance (connect, config acks) form the leading "session" group with
 * id 0.
 */
export function groupTurns(entries: readonly LedgerEntry[]): TurnGroup[] {
  let current: TurnGroup = { id: 0, entries: [] };
  const groups: TurnGroup[] = [current];
  for (const entry of entries) {
    const opens = entry.kind === "heard" || (entry.kind === "injected" && entry.role === "user");
    if (opens) {
      current = { id: entry.seq, entries: [entry] };
      groups.push(current);
    } else {
      current.entries.push(entry);
    }
  }
  return groups.filter((group) => group.entries.length > 0);
}

const clip = (text: string, n: number): string =>
  text.length > n ? `${text.slice(0, n - 1)}…` : text;

/** The one-line story of a turn: what was said, what it did, what it cost. */
export function summarizeTurn(group: TurnGroup): string {
  const opener = group.entries[0];
  if (group.id === 0 || opener === undefined) {
    return "session";
  }
  const asked =
    opener.kind === "heard"
      ? `🎙 ${clip(opener.text, 60)}`
      : opener.kind === "injected"
        ? `⌨ ${clip(opener.text ?? (opener.image === true ? "[image]" : ""), 60)}`
        : "";
  const tools = group.entries.filter((entry) => entry.kind === "tool-call").length;
  const errors = group.entries.filter((entry) => entry.kind === "error").length;
  const lastSaid = group.entries.filter((entry) => entry.kind === "said").at(-1);
  const tokens = group.entries.reduce(
    (sum, entry) =>
      entry.kind === "response" && entry.usage !== undefined
        ? sum + entry.usage.inputTokens + entry.usage.outputTokens
        : sum,
    0,
  );
  const bits = [asked];
  if (tools > 0) {
    bits.push(`⚙ ${tools}`);
  }
  if (errors > 0) {
    bits.push(`❌ ${errors}`);
  }
  if (lastSaid !== undefined && lastSaid.kind === "said") {
    bits.push(`🔮 ${clip(lastSaid.text, 60)}`);
  }
  if (tokens > 0) {
    bits.push(`${tokens} tok`);
  }
  return bits.join("  ·  ");
}

/** One entry as a line — the viewer's middle level of detail. */
export function entryLine(entry: LedgerEntry): string {
  switch (entry.kind) {
    case "session":
      return `${entry.phase}${entry.detail !== undefined ? ` — ${entry.detail}` : ""}`;
    case "config": {
      const tools = Array.isArray(entry.effective?.tools) ? entry.effective.tools.length : "?";
      const drift =
        entry.drift !== undefined && entry.drift.length > 0
          ? ` DRIFT: ${entry.drift.join("; ")}`
          : "";
      return `session config acked (${tools} tools)${drift}`;
    }
    case "speech":
      return `speech ${entry.phase}`;
    case "heard":
      return entry.text;
    case "said":
      return entry.text;
    case "tool-call":
      return `${entry.name}(${clip(entry.args, 120)}) [${entry.status}${
        entry.gateMs !== undefined ? `, gate ${entry.gateMs}ms` : ""
      }]`;
    case "tool-result":
      return `${entry.name} ${entry.ok ? "→" : "✗"} ${clip(entry.output, 120)} (${entry.ms}ms)`;
    case "injected":
      return `${entry.role}: ${entry.text ?? ""}${entry.image === true ? " [image]" : ""}`;
    case "response":
      return `response ${entry.status}${
        entry.usage !== undefined
          ? ` · in ${entry.usage.inputTokens} (${entry.usage.cachedInputTokens} cached) / out ${entry.usage.outputTokens}`
          : ""
      }`;
    case "error":
      return `${entry.source}: ${entry.message}`;
    case "raw":
      return entry.type;
  }
}

/** The entry's full payload, when there is more than the line — the deepest
 * detail level (rendered as JSON on expand). */
export function entryDetail(entry: LedgerEntry): unknown {
  switch (entry.kind) {
    case "config":
      return { sent: entry.sent, effective: entry.effective, drift: entry.drift };
    case "tool-call":
      return { callId: entry.callId, args: entry.args, status: entry.status, gateMs: entry.gateMs };
    case "tool-result":
      return { callId: entry.callId, ok: entry.ok, output: entry.output, ms: entry.ms };
    case "error":
      return entry.data ?? undefined;
    case "raw":
      return entry.event;
    default:
      return undefined;
  }
}

/** The mind strip's one-line answer to "what is it doing right now". */
export function activityLine(state: OracleState): { icon: string; text: string } {
  switch (state.status) {
    case "idle":
      return { icon: "⚪", text: "off" };
    case "connecting":
      return { icon: "◌", text: "connecting…" };
    case "parked":
      return { icon: "⏸", text: "parked — mic gated, session open" };
    case "closed":
      return { icon: "⚪", text: "session closed" };
    case "error":
      return { icon: "❌", text: "error — see the log" };
    case "live":
      if (state.speaking) {
        return { icon: "🎙", text: "listening…" };
      }
      if (state.runningTool !== undefined) {
        return { icon: "⚙", text: `doing: ${state.runningTool}` };
      }
      if (state.replying) {
        return state.replyText === ""
          ? { icon: "💭", text: "thinking…" }
          : { icon: "🔮", text: clip(state.replyText, 90) };
      }
      return { icon: "🟢", text: "ready — talk to it" };
  }
}
