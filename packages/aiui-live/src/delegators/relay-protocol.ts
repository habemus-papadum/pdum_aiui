/**
 * relay-protocol.ts — the frames between a browser session and a server
 * that hosts its delegator (`remoteDelegator` ↔ `createLiveBackend`). The
 * wire carries delegations OUT and appends BACK; tools the page owns round-
 * trip as `tool` / `tool_result` so a server-side backend (Claude Code) can
 * drive an aiui control surface that only exists in the browser.
 */

import type { LiveToolSpec, TranscriptSnapshot } from "../types.ts";

export type RelayClientFrame =
  | { type: "hello"; delegator: string; sessionId?: string }
  | {
      type: "delegate";
      id: string;
      text: string;
      transcript: TranscriptSnapshot;
      tools: LiveToolSpec[];
    }
  | { type: "cancel"; id: string }
  | { type: "tool_result"; callId: string; output: unknown };

export type RelayServerFrame =
  | { type: "ready"; delegator: string; description?: string }
  | { type: "say" | "note" | "steer"; id: string; text: string }
  | { type: "log"; id?: string; line: string }
  | { type: "done"; id: string; result?: string }
  | { type: "failed"; id: string; error: string }
  | { type: "tool"; id: string; callId: string; name: string; arguments: Record<string, unknown> }
  | { type: "error"; message: string };

export function encodeFrame(frame: RelayClientFrame | RelayServerFrame): string {
  return JSON.stringify(frame);
}

export function decodeFrame<T extends { type: string }>(raw: string): T | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      typeof (parsed as { type?: unknown }).type === "string"
    ) {
      return parsed as T;
    }
  } catch {
    // fall through
  }
  return undefined;
}
