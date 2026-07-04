/**
 * Pure aggregation + formatting helpers for the panel. Kept free of DOM and
 * chrome.* so they're unit-testable under plain vitest.
 */

/** Aggregate view of a set of round-trip times. */
export interface RttSummary {
  count: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
}

/** Nearest-rank percentile of an ascending-sorted array. */
export function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) {
    return 0;
  }
  const rank = Math.ceil((p / 100) * sortedAsc.length);
  return sortedAsc[Math.min(sortedAsc.length, Math.max(1, rank)) - 1];
}

/** Summarize round-trip times; null when there are none. */
export function summarizeRtt(rtts: number[]): RttSummary | null {
  if (rtts.length === 0) {
    return null;
  }
  const sorted = [...rtts].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, ms) => acc + ms, 0);
  return {
    count: sorted.length,
    avgMs: sum / sorted.length,
    p50Ms: percentile(sorted, 50),
    p95Ms: percentile(sorted, 95),
  };
}

/** Human byte size: 998 B, 12.3 KB, 4.0 MB. */
export function formatBytes(bytes: number): string {
  if (bytes < 1000) {
    return `${bytes} B`;
  }
  if (bytes < 1000_000) {
    return `${(bytes / 1000).toFixed(1)} KB`;
  }
  return `${(bytes / 1000_000).toFixed(1)} MB`;
}

/** Human duration: sub-millisecond precision only when it matters. */
export function formatMs(ms: number): string {
  if (ms < 1) {
    return `${ms.toFixed(2)} ms`;
  }
  if (ms < 100) {
    return `${ms.toFixed(1)} ms`;
  }
  if (ms < 10_000) {
    return `${Math.round(ms)} ms`;
  }
  return `${(ms / 1000).toFixed(1)} s`;
}

/** Relative time: "now", "12s ago", "3m ago", "2h ago". */
export function formatAgo(epochMs: number, nowMs: number): string {
  const s = Math.max(0, Math.round((nowMs - epochMs) / 1000));
  if (s < 2) {
    return "now";
  }
  if (s < 60) {
    return `${s}s ago`;
  }
  if (s < 3600) {
    return `${Math.floor(s / 60)}m ago`;
  }
  return `${Math.floor(s / 3600)}h ago`;
}
