/**
 * The channel trace poller behind the live-followed trace view.
 *
 * The channel exposes a cheap revision-poll (`/debug/api/traces/:id/live`,
 * `?since=<rev>` → `{unchanged:true}` when nothing moved), so following a live
 * thread is a fetch every second, not an open socket. See the channel's
 * debug.ts for the route.
 */

// ── channel trace polling ─────────────────────────────────────────────────────

/** A trace stage as the channel serves it (structural — no channel dep). */
export interface TraceStageLike {
  at?: string;
  kind?: "input" | "ir" | "output" | "info" | string;
  label?: string;
  data?: unknown;
  file?: string;
}

/** The `/debug/api/traces/:id/live` payload when something changed. */
export interface LiveTrace {
  rev: number;
  id?: string;
  format?: string;
  threadId?: string;
  status?: string;
  startedAt?: string;
  endedAt?: string;
  /** Who drove the client (`"human"` / `"agent"` — the hello's `meta.actor`). */
  actor?: string;
  /** Running USD roll-up of the turn's own model calls (see the channel's cost.ts). */
  costUsd?: number;
  stages: TraceStageLike[];
}

type LiveResponse = LiveTrace | { unchanged: true; rev: number };

export interface TracePollOptions {
  /** The channel origin, e.g. `http://127.0.0.1:8123` (no trailing slash). */
  baseUrl: string;
  traceId: string;
  /** Injected for tests; defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

export interface TracePollResult {
  /** Whether the trace advanced since the last poll. */
  changed: boolean;
  /** The current revision (echo it back as `?since=` to detect the next change). */
  rev: number;
  /** The full trace, present only when `changed`. */
  trace?: LiveTrace;
}

/**
 * A stateful poller over one trace. Remembers the last revision it saw and asks
 * the server only for what's new; pure enough to unit-test by driving `poll()`
 * against a stubbed fetch. Never throws — a fetch/parse failure reports "no
 * change" so a flaky server just pauses the follow rather than breaking it.
 */
export function createTracePoll(opts: TracePollOptions): {
  readonly rev: number | undefined;
  poll(): Promise<TracePollResult>;
  reset(): void;
} {
  // Wrapped for uniformity with the panes (a bare-call alias happens to keep
  // `this` = undefined, which native fetch tolerates — but one refactor into a
  // method call away from "Illegal invocation"; see traces-pane.ts).
  const doFetch =
    opts.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  let lastRev: number | undefined;

  return {
    get rev() {
      return lastRev;
    },
    reset() {
      lastRev = undefined;
    },
    async poll(): Promise<TracePollResult> {
      const since = lastRev === undefined ? "" : `?since=${encodeURIComponent(String(lastRev))}`;
      const url = `${opts.baseUrl}/debug/api/traces/${encodeURIComponent(opts.traceId)}/live${since}`;
      let body: LiveResponse;
      try {
        const res = await doFetch(url);
        if (!res.ok) {
          return { changed: false, rev: lastRev ?? 0 };
        }
        body = (await res.json()) as LiveResponse;
      } catch {
        return { changed: false, rev: lastRev ?? 0 };
      }
      if ("unchanged" in body && body.unchanged) {
        lastRev = body.rev;
        return { changed: false, rev: body.rev };
      }
      const trace = body as LiveTrace;
      lastRev = trace.rev;
      return { changed: true, rev: trace.rev, trace };
    },
  };
}
