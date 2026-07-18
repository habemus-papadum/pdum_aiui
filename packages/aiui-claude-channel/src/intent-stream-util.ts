/**
 * Pure stream/chunk helpers and the protocol floor constants for the
 * `intent-v1` lowering. A leaf: no shared turn state, imports only `IntentEvent`
 * from the pipeline package. The condition-pass slots (`silenceTrim`,
 * `imageDownscale`) are identity today — named so the attachment path and the
 * trace's stage sequence stay shaped for real trimming/downscaling when it ships.
 */
import type { IntentEvent } from "@habemus-papadum/aiui-lowering-pipeline";

/**
 * How long `fin` waits for a still-in-flight realtime `…completed` before it
 * finalizes the segment blank and composes anyway. Generous — a spoken segment's
 * final lands well inside a second (the bench measures ~0.8 s); this is the
 * ceiling that keeps a dropped upstream from hanging the send.
 */
export const REALTIME_DRAIN_TIMEOUT_MS = 10_000;

/**
 * The upstream's commit minimum: OpenAI rejects `input_audio_buffer.commit`
 * under 100 ms of audio ("buffer too small"). A Space tap released before the
 * worklet delivers its first frames streams less than this (often zero), so
 * talk-end discards such a segment instead of committing it — the debounce
 * that keeps a changed mind from erroring.
 */
export const MIN_REALTIME_COMMIT_MS = 100;
/** PCM16 mono at the realtime session's 24 kHz: 48 bytes per millisecond.
 * Exported so a test ties it to the channel's `REALTIME_VOICE_RATE` (pcm.ts). */
export const REALTIME_PCM_BYTES_PER_MS = 48;

// ── the cleanup passes (archive/workbench/openai-audio-stack.md) ─────────────
// Condition passes shrink/clean an upload *before* the expensive hop. The
// named slots keep the attachment path (and the trace's stage sequence) shaped
// for real trimming/downscaling when it ships; identity today, with no config
// knob until there is behavior to configure.

export const silenceTrim = (bytes: Uint8Array): Uint8Array => bytes;
export const imageDownscale = (bytes: Uint8Array): Uint8Array => bytes;

/** Parse the trailing ordinal of an identifier-shaped attachment id (`seg_3` → 3). */
export function ordinalOf(id: string): number {
  const match = /_(\d+)$/.exec(id);
  return match ? Number(match[1]) : 0;
}

/** A shot blob's file extension from its declared mime: S-key shots are PNG,
 * the share's sampled frames are JPEG. Default PNG for anything unexpected. */
export function imageExtension(mime: string): string {
  return mime === "image/jpeg" ? "jpg" : "png";
}

/** True when the current thread (from its last open) ended in an explicit cancel. */
export function endedInCancel(events: IntentEvent[]): boolean {
  let start = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === "thread-open") {
      start = i;
      break;
    }
  }
  const scope = start === -1 ? events : events.slice(start);
  for (let i = scope.length - 1; i >= 0; i--) {
    const event = scope[i];
    if (event.type === "thread-close") {
      return event.reason === "cancel";
    }
  }
  return false;
}

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

/** Decode a JSON chunk payload (events / context frames). */
export function decodeJson(bytes: Uint8Array): unknown {
  if (bytes.length === 0) {
    return undefined;
  }
  return JSON.parse(utf8Decoder.decode(bytes));
}

/** Narrow a decoded events chunk to `IntentEvent[]` (append-only batch). */
export function readEventBatch(decoded: unknown): IntentEvent[] {
  if (decoded === null || typeof decoded !== "object") {
    throw new Error('intent-v1 events chunk must be JSON { "events": IntentEvent[] }');
  }
  const { events } = decoded as { events?: unknown };
  if (!Array.isArray(events)) {
    throw new Error('intent-v1 events chunk is missing an "events" array');
  }
  return events as IntentEvent[];
}
