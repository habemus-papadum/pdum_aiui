/**
 * The raw-frame feed: a since-cursor poller over the debug channel's
 * `GET /debug/api/frames` ring (every websocket frame in either direction,
 * as recorded server-side). One feed fans out to every pane that wants it —
 * the Raw pane renders all entries, the Prompt pane filters for the
 * `lowered-prompt` pushes.
 *
 * Fetch is injectable and the poller is timer-driven, so tests run it without
 * a server.
 */

/** Mirrors the channel's FrameLogEntry (see aiui-claude-channel frame-log.ts). */
export interface FrameEntry {
  seq: number;
  /** ISO timestamp. */
  at: string;
  dir: "in" | "out";
  threadId?: string;
  label: string;
  data?: unknown;
  bytes?: number;
}

export interface FramesFeedOptions {
  /** Channel base URL, e.g. "http://127.0.0.1:5123". */
  baseUrl: string;
  intervalMs?: number;
  fetch?: typeof fetch;
}

/** How much history the feed replays to a late subscriber (the server ring is the real buffer). */
const MAX_BUFFERED = 500;

export class FramesFeed {
  private readonly listeners = new Set<(entries: FrameEntry[]) => void>();
  private readonly baseUrl: string;
  private readonly intervalMs: number;
  private readonly fetchFn: typeof fetch;
  private since = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  /**
   * Everything this feed has seen, bounded — replayed to each new subscriber.
   * Without this, the shared `since` cursor makes tab order lossy: the panes
   * subscribe on activate and unsubscribe on tab switch, so opening Prompt
   * first advanced the cursor past the whole turn and a later Raw-frames tab
   * rendered nothing at all (the empty-pane bug). History must come from the
   * feed, not from whoever happened to be listening when it arrived.
   */
  private buffer: FrameEntry[] = [];

  constructor(options: FramesFeedOptions) {
    this.baseUrl = options.baseUrl;
    this.intervalMs = options.intervalMs ?? 1000;
    // Wrap, don't alias — `this.fetchFn(...)` on a bare native fetch is an
    // "Illegal invocation" (see traces-pane.ts; it killed all three panes).
    this.fetchFn = options.fetch ?? ((input, init) => fetch(input, init));
  }

  subscribe(listener: (entries: FrameEntry[]) => void): () => void {
    this.listeners.add(listener);
    if (this.buffer.length > 0) {
      listener(this.buffer.slice()); // catch the newcomer up before live ticks
    }
    if (!this.timer) {
      this.timer = setInterval(() => void this.poll(), this.intervalMs);
      void this.poll();
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0 && this.timer) {
        clearInterval(this.timer);
        this.timer = undefined;
      }
    };
  }

  /** One poll tick; a fetch failure is "no change", never an exception. */
  async poll(): Promise<void> {
    try {
      const res = await this.fetchFn(`${this.baseUrl}/debug/api/frames?since=${this.since}`);
      if (!res.ok) {
        return;
      }
      const payload = (await res.json()) as { seq?: number; entries?: FrameEntry[] };
      const entries = payload.entries ?? [];
      if (typeof payload.seq === "number") {
        this.since = payload.seq;
      }
      if (entries.length > 0) {
        this.buffer.push(...entries);
        if (this.buffer.length > MAX_BUFFERED) {
          this.buffer.splice(0, this.buffer.length - MAX_BUFFERED);
        }
        for (const listener of this.listeners) {
          listener(entries);
        }
      }
    } catch {
      // channel restarting / not up yet — the next tick retries
    }
  }
}

/** The lowered-prompt push payload, when a frame entry is one. */
export function loweredPromptOf(
  entry: FrameEntry,
): { threadId: string; prompt: string; meta?: Record<string, string> } | undefined {
  if (entry.dir !== "out" || !entry.label.includes("lowered-prompt")) {
    return undefined;
  }
  const data = entry.data as
    | { kind?: string; threadId?: string; prompt?: string; meta?: Record<string, string> }
    | undefined;
  if (data?.kind !== "lowered-prompt" || typeof data.prompt !== "string") {
    return undefined;
  }
  return {
    threadId: typeof data.threadId === "string" ? data.threadId : "?",
    prompt: data.prompt,
    ...(data.meta !== undefined ? { meta: data.meta } : {}),
  };
}
