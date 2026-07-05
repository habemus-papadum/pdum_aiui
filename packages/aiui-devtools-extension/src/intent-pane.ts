/**
 * Pure helpers for the panel's **Intent** pane — port memory, the channel base
 * URL, the degraded-key line, and trace-list formatting. Kept import-free and
 * side-effect-free (like tab-info.ts) so the DOM-heavy wiring in panel.ts stays
 * thin and this logic is unit-testable without Chrome or a document.
 *
 * Port discovery (per the graduation handoff, option a): the inspected page's
 * `window.__AIUI__.port` is primary; when there's no instrumented page, the
 * panel falls back to a manual field seeded from these remembered recents.
 */

/** localStorage key holding recently-used channel ports (newest first). */
export const RECENT_PORTS_KEY = "aiui.recentPorts";

const MAX_RECENTS = 6;

/** Put `port` at the front of the recents list, de-duped and capped. */
export function addRecentPort(recents: number[], port: number, max = MAX_RECENTS): number[] {
  if (!Number.isInteger(port) || port <= 0) {
    return recents;
  }
  return [port, ...recents.filter((p) => p !== port)].slice(0, max);
}

/** Read remembered ports, tolerating absent/garbage storage. */
export function loadRecentPorts(
  storage: Pick<Storage, "getItem"> | undefined,
  key = RECENT_PORTS_KEY,
): number[] {
  if (!storage) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(storage.getItem(key) ?? "[]");
    return Array.isArray(parsed)
      ? parsed.filter((p): p is number => Number.isInteger(p) && (p as number) > 0)
      : [];
  } catch {
    return [];
  }
}

/** Persist remembered ports, swallowing storage failures (private mode, quota). */
export function saveRecentPorts(
  storage: Pick<Storage, "setItem"> | undefined,
  recents: number[],
  key = RECENT_PORTS_KEY,
): void {
  try {
    storage?.setItem(key, JSON.stringify(recents));
  } catch {
    // best-effort: memory persistence is a convenience, never load-bearing
  }
}

/** The channel origin for a loopback port. */
export function channelBaseUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

/**
 * The one-line explanation for a degraded pipeline, or null when the key is
 * good/unknown-and-fine. Driven by the launcher's `openaiKey` *status* (never
 * the key) as surfaced under `/debug/api/info` → `launch.openaiKey`.
 */
export function degradedKeyLine(status: string | undefined): string | null {
  switch (status) {
    case undefined:
    case "valid":
      return null;
    case "missing":
      return "OPENAI_API_KEY isn't set — transcription and correction are unavailable until it's set (or switch the overlay to the mock backends for offline work).";
    case "invalid":
      return "OPENAI_API_KEY was rejected (a stale shell export?) — transcription and correction are unavailable until it's fixed.";
    case "unverified":
      return "OPENAI_API_KEY wasn't verified at launch — transcription and correction may be unavailable.";
    default:
      return "OPENAI_API_KEY is unusable — transcription and correction are unavailable (the pipeline runs degraded).";
  }
}

/** A trace as the listing route returns it (subset the pane needs). */
export interface TraceSummary {
  id: string;
  format: string;
  startedAt?: string;
  status?: string;
  stages?: unknown[];
}

/** The secondary line under a trace's format in the picker. */
export function traceSummaryLine(t: TraceSummary): string {
  const n = t.stages?.length ?? 0;
  const started = t.startedAt ? new Date(t.startedAt).toLocaleTimeString() : "";
  return `${started ? `${started} · ` : ""}${n} stage${n === 1 ? "" : "s"} · ${t.status ?? "live"}`;
}
