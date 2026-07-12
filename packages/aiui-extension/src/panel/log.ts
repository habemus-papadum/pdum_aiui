/**
 * Leveled console logging for the panel — the ROUTINE-feedback channel of the
 * 2026-07-12 advisory redesign (state transitions, capture progress, binding
 * flow). The `logLevel` control gates it: "quiet" (nothing), "info" (the
 * default narration), "debug" (chatty — per-keystroke blips, capture phases).
 * Toasts (toasts.tsx) are the misuse channel; inline pane hints are retired.
 *
 * These land in the PANEL document's console — open it via "Inspect" on the
 * side panel (right-click) or chrome://extensions → service worker/views.
 */
import { logLevel } from "./model/store";

const RANK = { quiet: 0, info: 1, debug: 2 } as const;
type Level = keyof typeof RANK;

const enabled = (level: Level): boolean => RANK[(logLevel.get() as Level) ?? "info"] >= RANK[level];

export function logInfo(...args: unknown[]): void {
  if (enabled("info")) {
    console.info("[aiui]", ...args);
  }
}

export function logDebug(...args: unknown[]): void {
  if (enabled("debug")) {
    console.debug("[aiui]", ...args);
  }
}
