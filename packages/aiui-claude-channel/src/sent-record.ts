/**
 * sent-record.ts — the last things pushed into the Claude Code session, WHOLE.
 *
 * The lowering traces record a lowered prompt with its spans, but the session
 * also receives text that no trace covers: the startup, stale and error
 * notices, and raw `POST /prompt` text (the `quick` command, a sidecar's
 * notice). Until the prompt toolkit lands and every one of these is a
 * structured record (docs/proposals/structured-prompts-review.md), this
 * bounded ring is the honest "what did the session get" — kind, text and the
 * meta that became the channel block's attributes — served on
 * `GET /debug/api/sent`.
 */

export interface SentEntry {
  /** ISO timestamp. */
  at: string;
  /** The `meta.kind` of the notification: `prompt`, `startup`, `channel-stale`, `channel-error`. */
  kind: string;
  /** The text, as pushed. */
  text: string;
  /** Extra meta that rode with it (attachment paths, …), when any. */
  meta?: Record<string, string>;
}

export interface SentRecord {
  push(kind: string, text: string, meta?: Record<string, string>): void;
  /** Oldest first. */
  list(): SentEntry[];
}

/** A ring of the last `limit` pushes (default 50). */
export function createSentRecord(limit = 50, now: () => Date = () => new Date()): SentRecord {
  const entries: SentEntry[] = [];
  return {
    push(kind, text, meta) {
      entries.push({
        at: now().toISOString(),
        kind,
        text,
        ...(meta !== undefined && Object.keys(meta).length > 0 ? { meta } : {}),
      });
      if (entries.length > limit) entries.splice(0, entries.length - limit);
    },
    list: () => [...entries],
  };
}
