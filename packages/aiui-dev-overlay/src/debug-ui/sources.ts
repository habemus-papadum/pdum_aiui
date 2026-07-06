/**
 * Data sources for the debug panes: two ways to get an {@link IntentEvent}
 * stream behind one small interface.
 *
 *  - {@link engineSource} wraps a live {@link Engine} — the lab's case, where
 *    the panes render the very stream the user is producing.
 *  - {@link traceLiveSource} polls a channel trace over HTTP — the extension's
 *    case, where the panes live-follow a thread the channel is lowering in
 *    another process. It pulls the event log out of whatever stage carries it
 *    (a trace records the log as a stage payload), so it works for any modality
 *    that records one and stays quiet for those that don't (text-concat).
 *
 * The channel exposes a cheap revision-poll (`/debug/api/traces/:id/live`,
 * `?since=<rev>` → `{unchanged:true}` when nothing moved), so following a live
 * thread is a fetch every second, not an open socket. See the channel's
 * debug.ts for the route.
 */
import type { Engine, IntentEvent } from "../intent-pipeline";

/** A subscribable source of the current thread's event stream. */
export interface DebugSource {
  /**
   * Register a callback for the event stream; it fires once immediately with
   * the current events and again whenever they change. Returns an unsubscribe.
   */
  subscribe(cb: (events: IntentEvent[]) => void): () => void;
  /** A short human label for where these events come from. */
  readonly label?: string;
  /** Release any polling/listeners the source holds. */
  dispose?(): void;
}

/** Wrap a live engine: replay its events on subscribe, forward each new one. */
export function engineSource(engine: Engine): DebugSource {
  return {
    label: "engine",
    subscribe(cb) {
      // The engine's onEvent has no detach; a `live` flag makes unsubscribe
      // real from the source's side (stop forwarding) without touching it.
      let live = true;
      cb(engine.events.slice());
      engine.onEvent(() => {
        if (live) {
          cb(engine.events.slice());
        }
      });
      return () => {
        live = false;
      };
    },
  };
}

/** A fixed, already-captured stream (fixtures, an embedded event-log stage). */
export function staticSource(events: IntentEvent[]): DebugSource {
  return {
    subscribe(cb) {
      cb(events);
      return () => {};
    },
  };
}

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
  /** The extracted event log, when a stage carried one. */
  events?: IntentEvent[];
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
      return { changed: true, rev: trace.rev, trace, events: extractIntentEvents(trace.stages) };
    },
  };
}

export interface TraceLiveOptions extends TracePollOptions {
  /** Poll cadence in ms (default 1000). */
  intervalMs?: number;
}

/**
 * A {@link DebugSource} that live-follows a channel trace, forwarding its event
 * log to subscribers as it grows. The timer runs only while subscribed.
 */
export function traceLiveSource(opts: TraceLiveOptions): DebugSource {
  const poll = createTracePoll(opts);
  const callbacks = new Set<(events: IntentEvent[]) => void>();
  let timer: ReturnType<typeof setInterval> | undefined;

  const run = async (): Promise<void> => {
    const result = await poll.poll();
    if (result.changed && result.events) {
      for (const cb of callbacks) {
        cb(result.events);
      }
    }
  };

  const stop = (): void => {
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
  };

  return {
    label: `trace ${opts.traceId}`,
    subscribe(cb) {
      callbacks.add(cb);
      if (!timer) {
        void run();
        timer = setInterval(() => void run(), opts.intervalMs ?? 1000);
      }
      return () => {
        callbacks.delete(cb);
        if (callbacks.size === 0) {
          stop();
        }
      };
    },
    dispose() {
      callbacks.clear();
      stop();
    },
  };
}

/**
 * Feature-detect an {@link IntentEvent} log inside a trace's stages: the last
 * stage whose payload is a non-empty array of `{at:number, type:string}`
 * objects. Returns undefined for traces that carry no event log (e.g.
 * text-concat), which is how the panes know to fall back to a generic view.
 */
export function extractIntentEvents(
  stages: TraceStageLike[] | undefined,
): IntentEvent[] | undefined {
  if (!Array.isArray(stages)) {
    return undefined;
  }
  let found: IntentEvent[] | undefined;
  for (const stage of stages) {
    if (isEventLog(stage?.data)) {
      found = stage.data as IntentEvent[];
    }
  }
  return found;
}

function isEventLog(data: unknown): data is IntentEvent[] {
  return (
    Array.isArray(data) &&
    data.length > 0 &&
    data.every(
      (x) =>
        typeof x === "object" &&
        x !== null &&
        typeof (x as { at?: unknown }).at === "number" &&
        typeof (x as { type?: unknown }).type === "string",
    )
  );
}
