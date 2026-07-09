/**
 * The channel's frame log: a bounded in-memory ring of every protocol message
 * the web backend saw on the `/ws` endpoint — hellos, data chunks, acks, and
 * server → client pushes — each stamped with a monotonically increasing `seq`.
 * `GET /debug/api/frames?since=<seq>` (see debug.ts) serves it; a debug client's
 * raw-JSON pane polls that route with the last `seq` it has seen.
 *
 * The log is recorded unconditionally (not gated on the server's debug mode)
 * because it is generally useful and cheap when nobody polls: entries carry
 * parsed JSON only for the small text payloads (envelopes, event batches,
 * acks), and just a **byte count** for binary payloads — audio PCM and shot
 * PNGs live in the trace blob store, never here. Likewise a `speech` push's
 * base64 audio is replaced by its length before it enters the ring, so neither
 * the ring nor a recording sink ever holds megabytes of base64.
 *
 * An optional {@link FrameLogSink} observes every entry as it is recorded —
 * the one-function seam recording mode plugs into (see recording.ts); other
 * sinks (live websocket taps, metrics) can attach the same way later.
 */
import type { ChannelResponse } from "./channel";
import { decodeFrame } from "./frame";

/** One logged protocol message, as the server saw it. */
export interface FrameLogEntry {
  /**
   * Monotonically increasing, 1-based. Survives ring eviction (it never
   * resets), so a poller's `since` cursor stays valid across overflow.
   */
  seq: number;
  /** When the entry was recorded (ISO timestamp). */
  at: string;
  /** Direction: `in` = client → server frame, `out` = server → client message. */
  dir: "in" | "out";
  /** The thread the message belonged to, when it named one. */
  threadId?: string;
  /** Short human label, e.g. `"hello"`, `"chunk events"`, `"push lowered-prompt"`. */
  label: string;
  /** Parsed JSON content, for text-shaped payloads (envelopes, acks, pushes). */
  data?: unknown;
  /** Payload byte count, for binary payloads (the bytes live in the trace store). */
  bytes?: number;
}

/** Observes every recorded entry (the recording seam — see recording.ts). */
export type FrameLogSink = (entry: FrameLogEntry) => void;

/** The bounded ring itself. */
export interface FrameLog {
  /** Append one entry (the `seq`/`at` stamps are added here). */
  record(entry: Omit<FrameLogEntry, "seq" | "at">): void;
  /**
   * The latest `seq` plus every retained entry newer than `since` (`0`, the
   * default, returns everything still in the ring), oldest first.
   */
  snapshot(since?: number): { seq: number; entries: FrameLogEntry[] };
}

export interface FrameLogOptions {
  /** Ring capacity (default {@link FRAME_LOG_LIMIT}). */
  limit?: number;
  /** Sink called with every recorded entry. Best-effort: a throw is swallowed. */
  sink?: FrameLogSink;
}

/** How many entries the ring keeps. */
export const FRAME_LOG_LIMIT = 500;

/** Create an in-memory frame log. */
export function createFrameLog(options: FrameLogOptions = {}): FrameLog {
  const limit = options.limit ?? FRAME_LOG_LIMIT;
  const entries: FrameLogEntry[] = [];
  let seq = 0;

  return {
    record(entry) {
      seq += 1;
      const full: FrameLogEntry = { seq, at: new Date().toISOString(), ...entry };
      entries.push(full);
      if (entries.length > limit) {
        entries.splice(0, entries.length - limit);
      }
      try {
        options.sink?.(full);
      } catch {
        // a broken sink must never break the prompt path
      }
    },
    snapshot(since = 0) {
      // Entries are seq-ascending; a linear filter is fine at ring size.
      return { seq, entries: entries.filter((entry) => entry.seq > since) };
    },
  };
}

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

/**
 * Describe one inbound binary frame. The envelope is decoded a second time
 * here (the connection state machine consumes only raw bytes and returns only
 * the ack) — the header is tiny JSON, so re-decoding is cheaper than
 * re-plumbing the connection to expose envelopes. Payload JSON is inlined only
 * for the small text chunk kinds (`events`/`context`); binary payloads
 * contribute a byte count.
 */
export function inboundEntry(frame: Uint8Array): Omit<FrameLogEntry, "seq" | "at"> {
  let envelope: ReturnType<typeof decodeFrame>["envelope"];
  let payload: Uint8Array;
  try {
    ({ envelope, payload } = decodeFrame(frame));
  } catch {
    return { dir: "in", label: "malformed frame", bytes: frame.length };
  }
  if (envelope.kind === "hello") {
    // The envelope carries the hello's meta (tab/source/intent/actor) inline.
    return { dir: "in", label: "hello", data: envelope };
  }
  const threadId =
    typeof envelope.threadId === "string" && envelope.threadId !== ""
      ? { threadId: envelope.threadId }
      : {};
  const fin = envelope.fin === true ? " (fin)" : "";
  const chunk = envelope.chunk;
  if (chunk === undefined) {
    // The bare chunkless fin is the intent-v1 terminator; legacy formats
    // (text-concat) send chunkless payloads whose codec this layer can't know.
    return envelope.fin === true && payload.length === 0
      ? { dir: "in", label: "fin", ...threadId }
      : { dir: "in", label: `data${fin}`, bytes: payload.length, ...threadId };
  }
  if (chunk.kind === "events" || chunk.kind === "context") {
    try {
      return {
        dir: "in",
        label: `chunk ${chunk.kind}${fin}`,
        ...(payload.length > 0 ? { data: JSON.parse(utf8Decoder.decode(payload)) } : {}),
        ...threadId,
      };
    } catch {
      // Not valid JSON after all — fall through to the byte-count shape.
      return { dir: "in", label: `chunk ${chunk.kind}${fin}`, bytes: payload.length, ...threadId };
    }
  }
  const label =
    chunk.kind === "attachment"
      ? `chunk attachment ${chunk.id} (${chunk.mime})${fin}`
      : `chunk audio ${chunk.id} #${chunk.seq}${fin}`;
  return { dir: "in", label, bytes: payload.length, ...threadId };
}

/** Describe one outbound per-frame ack. */
export function ackEntry(response: ChannelResponse): Omit<FrameLogEntry, "seq" | "at"> {
  return {
    dir: "out",
    label: "ack",
    data: response,
    ...(response.threadId !== undefined ? { threadId: response.threadId } : {}),
  };
}

/**
 * Describe one outbound push (a kind-tagged server → client message). A
 * `speech` push's base64 `data` field is replaced by its character count so
 * audio clips never enter the ring or a recording (the clip's spoken text and
 * byte size are already in the trace — see intent-v1.ts's `pushSpeech`).
 */
export function pushEntry(message: unknown): Omit<FrameLogEntry, "seq" | "at"> {
  const shaped = message as { kind?: unknown; threadId?: unknown; data?: unknown };
  const kind = typeof shaped?.kind === "string" ? shaped.kind : "unknown";
  const data =
    kind === "speech" && typeof shaped.data === "string"
      ? { ...(message as Record<string, unknown>), data: shaped.data.length }
      : message;
  return {
    dir: "out",
    label: `push ${kind}`,
    data,
    ...(typeof shaped?.threadId === "string" ? { threadId: shaped.threadId } : {}),
  };
}
