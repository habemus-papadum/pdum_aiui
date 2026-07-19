/**
 * The binary frame format for the `/ws` channel.
 *
 * One WebSocket binary frame carries one channel message:
 *
 * ```
 *   ┌────────┬───────────────────────┬────────────────┐
 *   │ u32 BE │ header (UTF-8 JSON)    │ payload bytes  │
 *   │ hdrLen │ the Envelope          │ raw / opaque   │
 *   └────────┴───────────────────────┴────────────────┘
 * ```
 *
 * WebSocket already delimits whole messages and gives us each frame's length,
 * so we length-prefix only the *header* — the payload is simply the rest of
 * the frame. The payload is opaque bytes produced by a format's codec (JSON
 * for text formats, raw for audio/video/screenshots); it is never base64'd,
 * and decoding it is zero-copy (a subarray view into the received frame).
 *
 * Everything here uses only `TextEncoder`/`TextDecoder`/`DataView`, so it runs
 * unchanged in the browser as well as Node — a client re-implements the whole
 * format in ~20 lines. Big-endian u32 is network byte order.
 */

import type { TabInfo } from "@habemus-papadum/aiui-lowering-pipeline";

/** Bump when a change to the framing or envelope shape is not backward-compatible. */
export const PROTOCOL_VERSION = 1;

/** The kind of message an {@link Envelope} carries. */
export type EnvelopeKind = "hello" | "data";

/**
 * The browser tab a client page lives in, as far as the page can know it — the
 * shared {@link TabInfo} from the lowering pipeline (a {@link
 * import("@habemus-papadum/aiui-lowering-pipeline").TabRecord} projection). Its
 * `url`/`title` the page reads live off itself; the numeric/string ids come
 * from the intent client's host — the MV3 extension's `chrome.tabs` layer, or
 * the CDP tier's tab hints. All ids are **correlation hints** for an agent:
 * the Chrome DevTools MCP accepts only its own `pageId` from `list_pages` —
 * match by URL/title and verify (the session-browser skill teaches the
 * workflow; background in archive/chrome-devtools-mcp-tab-routing-notes.md).
 * Re-exported here so this module's consumers keep one import site.
 */
export type { TabInfo };

/** Where the page's source code lives on disk (from the dev server). */
export interface SourceInfo {
  /** The dev server's source root (the Vite root) — an absolute path. */
  root?: string;
}

/** Optional client context sent once, on the `hello` frame. */
export interface HelloMeta {
  /** The browser tab the connection was opened from. */
  tab?: TabInfo;
  /** Where the page's source code lives. */
  source?: SourceInfo;
  /**
   * Who is driving this connection: `"human"` | `"agent"` | free-form.
   * Self-reported by the client (automation should default to `"agent"`);
   * recorded on the trace manifest as provenance, so the /debug viewer can
   * badge non-human runs. Absent means unknown — treated like a human client.
   */
  actor?: string;
  /**
   * The client's view of its `IntentPipelineConfig` (the `intent-v1` format
   * reads which transcriber/corrector/models/policy/passes to run from it).
   * Typed loosely on purpose — the envelope carries no dependency on the
   * pipeline package; the processor validates the fields it uses.
   */
  intent?: unknown;
}

/**
 * What an `intent-v1` `data` frame carries, tagged in the envelope so the
 * processor can interpret an otherwise-opaque payload without peeking inside
 * it. Absent on every other format (and on legacy frames), which keeps
 * `text-concat` and the like unaffected.
 *
 *  - `events` — payload is UTF-8 JSON `{ events: IntentEvent[] }` (an
 *    append-only batch of the client's interaction log);
 *  - `attachment` — payload is raw bytes (a shot PNG or a whole audio segment),
 *    identified by `id` (`shot_N` / `seg_N`) and `mime`;
 *  - `audio` — payload is raw bytes: **one streamed PCM frame** of segment
 *    `seg_N`, in `seq` order (the streaming-transcriber path, archive/streaming-turns.md
 *    §3): the segment arrives as many frames *while you talk*; its existing
 *    `talk-start`/`talk-end` events remain the boundaries (talk-end commits
 *    the upstream buffer). An `attachment seg_N` — one whole segment in one
 *    frame, the retired REST wire shape — is still tolerated and blob-saved,
 *    but nothing transcribes it. Additive, like every other member — its
 *    absence is the legacy behavior every non-`intent-v1` format relies on,
 *    so `PROTOCOL_VERSION` is unaffected;
 *  - `control` — payload is UTF-8 JSON `{ control, value }`: a mid-thread
 *    reconfiguration the processor applies live, distinct from turn content
 *    (it never reaches the composed prompt). Three controls today:
 *    `{ control: "linter", value: "off" | "openai" | "gemini" }` — the client
 *    switching the prompt-linter on/off/vendor without closing the turn;
 *    `{ control: "lint", value: "now" | "stop" }` — the converse turn
 *    strategy's button pair (`now` ends the lint turn at the button, `stop`
 *    cancels the in-flight reply; capture-bus-and-consumers.md §6 Phase 1);
 *    and `{ control: "oracle", value: "off" | "openai" }` — the oracle
 *    starting/stopping on the current thread (Phase 2; XOR with the linter,
 *    enforced by the handler in both directions).
 */
export type ChunkDescriptor =
  | { kind: "events" }
  | { kind: "control" }
  | { kind: "attachment"; id: string; mime: string }
  | { kind: "audio"; id: string; seq: number; mime: string };

/** The routing/lifecycle metadata carried in every frame's header. */
export interface Envelope {
  /** Protocol version (see {@link PROTOCOL_VERSION}). */
  v: number;
  /** What this frame is. */
  kind: EnvelopeKind;
  /** On a `hello`: the stream format the connection will speak. */
  format?: string;
  /** On a `hello`: optional client context (tab identity, source location). */
  meta?: HelloMeta;
  /** On a `data` frame: the client-generated thread id it belongs to. */
  threadId?: string;
  /** On a `data` frame: true when this is the thread's final frame. */
  fin?: boolean;
  /**
   * On an `intent-v1` `data` frame: how to interpret the payload (see
   * {@link ChunkDescriptor}). Absent on other formats and legacy frames.
   */
  chunk?: ChunkDescriptor;
}

/** A decoded frame: its envelope plus a (zero-copy) view of its payload. */
export interface DecodedFrame {
  envelope: Envelope;
  /** The opaque payload bytes — a view into the source frame, not a copy. */
  payload: Uint8Array;
}

const HEADER_LENGTH_BYTES = 4;
const EMPTY = new Uint8Array(0);
const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

/**
 * Serialize an envelope and payload into a single binary frame. The payload is
 * copied once into the frame (WebSocket sends one contiguous buffer); nothing
 * is base64'd.
 */
export function encodeFrame(envelope: Envelope, payload: Uint8Array = EMPTY): Uint8Array {
  const header = utf8Encoder.encode(JSON.stringify(envelope));
  const frame = new Uint8Array(HEADER_LENGTH_BYTES + header.length + payload.length);
  new DataView(frame.buffer).setUint32(0, header.length, false);
  frame.set(header, HEADER_LENGTH_BYTES);
  frame.set(payload, HEADER_LENGTH_BYTES + header.length);
  return frame;
}

/**
 * Parse a binary frame back into its envelope and payload. The returned
 * payload is a subarray view of `frame` (no copy) — callers that retain it
 * past the current tick should copy it.
 *
 * @throws if the frame is truncated or its header is not valid JSON.
 */
export function decodeFrame(frame: Uint8Array): DecodedFrame {
  if (frame.length < HEADER_LENGTH_BYTES) {
    throw new Error("frame too short: missing 4-byte header length prefix");
  }
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const headerLength = view.getUint32(0, false);
  const headerEnd = HEADER_LENGTH_BYTES + headerLength;
  if (headerEnd > frame.length) {
    throw new Error(`frame too short: header length ${headerLength} exceeds frame`);
  }
  let envelope: Envelope;
  try {
    envelope = JSON.parse(utf8Decoder.decode(frame.subarray(HEADER_LENGTH_BYTES, headerEnd)));
  } catch {
    throw new Error("frame header is not valid UTF-8 JSON");
  }
  return { envelope, payload: frame.subarray(headerEnd) };
}
