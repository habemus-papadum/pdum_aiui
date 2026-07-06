/**
 * Browser-side client for the channel's binary `/ws` protocol.
 *
 * This is the deliberate ~40-line reimplementation the wire format was
 * designed to allow (see `frame.ts` in `@habemus-papadum/aiui-claude-channel`,
 * the source of truth): one binary WebSocket frame = `u32 BE header length` +
 * `UTF-8 JSON envelope` + `raw payload bytes`. A connection opens with a
 * `hello` naming a stream format, then sends `data` frames tagged with
 * client-generated thread ids; the server acks each frame with a small JSON
 * text message. Re-implementing keeps this package dependency-free and
 * browser-only; the tests cross-check our bytes against the channel package's
 * decoder.
 */

import { type ClientMeta, recordFrameMetric } from "./instrumentation";

/** Must match the channel package's PROTOCOL_VERSION. */
export const PROTOCOL_VERSION = 1;

/** The server's per-frame reply. */
export interface Ack {
  ok: boolean;
  threadId?: string;
  closed?: boolean;
  error?: string;
  fatal?: boolean;
}

/**
 * A streaming modality (`intent-v1`) tags its data frames with a `chunk` so the
 * server can tell an event batch from a raw attachment from the end-of-turn
 * context. `events`/`context` carry a JSON payload; `attachment` carries **raw
 * bytes** (PNG / a whole audio segment) and an `id` (`shot_N` / `seg_N`)
 * correlating it with the `shot`/`talk` event already on the wire; `audio`
 * carries **one streamed PCM frame** of `seg_N` (the realtime transcriber path),
 * in `seq` order, while the segment's `talk-start`/`talk-end` events stay the
 * boundaries. See the `intent-v1` contract in the multimodal-intent-graduation
 * and streaming-turns handoffs. Mirrors `ChunkDescriptor` in the channel's
 * `frame.ts` — the source of truth; change both together.
 */
export type JsonChunk = { kind: "events" } | { kind: "context" };
export type AttachmentChunk = { kind: "attachment"; id: string; mime: string };
export type AudioChunk = { kind: "audio"; id: string; seq: number; mime: string };
export type FrameChunk = JsonChunk | AttachmentChunk | AudioChunk;

/**
 * A server→client push on the same socket, distinguished from an {@link Ack} by
 * its `kind` field (acks never have one). The `intent-v1` server pushes
 * `{ kind: "lowered", threadId, events }` — the lowered echoes (a segment's
 * `transcript-final`, a completed `correction`) the client merges back into its
 * engine stream as if they had happened locally.
 */
export interface ServerMessage {
  kind: string;
  threadId?: string;
  [key: string]: unknown;
}

/**
 * The `lowered-prompt` push: on every successful `fin` the server broadcasts
 * the thread's final lowered prompt (plus its string meta) on the same socket.
 * Typed here so a client can narrow a {@link ServerMessage} on
 * `kind === "lowered-prompt"`. The overlay itself deliberately ignores it —
 * see the handler in multimodal/modality.ts — the workbench consumes it
 * server-side; the type exists for custom modalities that want the result.
 */
export interface LoweredPromptMessage extends ServerMessage {
  kind: "lowered-prompt";
  threadId: string;
  prompt: string;
  meta?: Record<string, string>;
}

/**
 * The generic `error` push — the single surface through which a server-side
 * failure (a stale OPENAI_API_KEY failing transcription, a correction diff
 * erroring, a degraded seam) reaches the page, instead of dying in the channel
 * process's log. Mirrors `ChannelErrorMessage` in the channel package's
 * `channel.ts` — the source of truth; change both together.
 *
 * The client itself also *synthesizes* this message for transport faults it
 * alone can see: {@link connectIntentSocket} delivers one to every
 * `onServerMessage` handler when the socket closes out from under a completed
 * hello (channel stopped, channel reloaded mid-turn). Client-detected and
 * server-pushed errors thereby render through one UI path — the intent tool's
 * toast column (see intent.ts).
 */
export interface ErrorMessage extends ServerMessage {
  kind: "error";
  /** The thread the failure belongs to; absent for connection-level faults. */
  threadId?: string;
  /** Coarse failure category (`"connection"`, `"transcription"`, …) — the badge. */
  source?: string;
  /** One informative human-readable sentence. */
  message: string;
  /** Optional second line: remediation, upstream error body, close reason. */
  detail?: string;
}

/** Narrow a {@link ServerMessage} to an {@link ErrorMessage} (kind + a real message). */
export function isErrorMessage(msg: ServerMessage): msg is ErrorMessage {
  return msg.kind === "error" && typeof (msg as { message?: unknown }).message === "string";
}

const utf8 = new TextEncoder();

/** Encode one binary frame: length-prefixed JSON envelope + payload bytes. */
export function encodeFrame(envelope: object, payload: Uint8Array = new Uint8Array(0)): Uint8Array {
  const header = utf8.encode(JSON.stringify(envelope));
  const frame = new Uint8Array(4 + header.length + payload.length);
  new DataView(frame.buffer).setUint32(0, header.length, false);
  frame.set(header, 4);
  frame.set(payload, 4 + header.length);
  return frame;
}

/** Encode a JSON payload the way the server's `jsonCodec` decodes it. */
export function encodeJsonPayload(value: unknown): Uint8Array {
  return utf8.encode(JSON.stringify(value ?? null));
}

/** The subset of the WebSocket API the client uses — injectable for tests. */
export interface WebSocketLike {
  binaryType: string;
  send(data: Uint8Array): void;
  close(): void;
  addEventListener(type: string, listener: (event: never) => void): void;
}

/** Constructs a {@link WebSocketLike} — the browser's `WebSocket` by default. */
export type WebSocketFactory = (url: string) => WebSocketLike;

/** A connected, hello-completed channel socket. */
export interface IntentSocket {
  /** Send one JSON data frame for a thread; resolves with the server's ack. */
  send(threadId: string, payload: unknown, fin: boolean): Promise<Ack>;
  /**
   * Send a tagged JSON chunk (an `events` batch or the end-of-turn `context`)
   * for a streaming thread. `fin` marks the thread's final frame.
   */
  sendChunk(threadId: string, chunk: JsonChunk, payload: unknown, fin?: boolean): Promise<Ack>;
  /**
   * Send a raw-binary attachment chunk (a shot PNG or a whole audio segment) —
   * the bytes ride the frame's payload verbatim, never base64'd.
   */
  sendAttachment(
    threadId: string,
    chunk: AttachmentChunk,
    bytes: Uint8Array,
    fin?: boolean,
  ): Promise<Ack>;
  /**
   * Send one streamed PCM frame of a talk segment (the realtime path) — raw
   * bytes on the payload, `seq`/`id` in the envelope chunk. Same wire shape as
   * {@link sendAttachment}; a distinct method only so the `audio` chunk's `seq`
   * is carried.
   */
  sendAudio(threadId: string, chunk: AudioChunk, bytes: Uint8Array, fin?: boolean): Promise<Ack>;
  /**
   * Register a handler for server pushes (messages carrying a `kind`) — the
   * lowered echoes an `intent-v1` thread merges back in. Acks are never routed
   * here. Multiple handlers are allowed; each fires per push.
   */
  onServerMessage(handler: (msg: ServerMessage) => void): void;
  close(): void;
}

const defaultFactory: WebSocketFactory = (url) => new WebSocket(url) as unknown as WebSocketLike;

/**
 * Connect to a channel server's `/ws`, complete the format hello, and resolve
 * with a socket ready to send data frames. Rejects if the connection fails or
 * the server refuses the format. `meta` (tab identity, source location) rides
 * the hello envelope so the server can contextualize everything the
 * connection sends.
 */
export function connectIntentSocket(
  url: string,
  format: string,
  factory: WebSocketFactory = defaultFactory,
  meta?: ClientMeta,
): Promise<IntentSocket> {
  const socket = factory(url);
  socket.binaryType = "arraybuffer";

  /** What we need to complete an ack and record its frame metric. */
  interface Pending {
    resolve: (ack: Ack) => void;
    kind: "hello" | "data";
    threadId?: string;
    fin?: boolean;
    bytes: number;
    sentAt: number;
  }

  // Acks arrive one per frame, in send order: a FIFO pairs them up. Settling an
  // entry also records its frame metric (size + round-trip) for the DevTools
  // panel — see instrumentation.ts.
  const pending: Pending[] = [];
  const settle = (entry: Pending, ack: Ack): void => {
    recordFrameMetric({
      at: entry.sentAt,
      format,
      kind: entry.kind,
      ...(entry.threadId !== undefined ? { threadId: entry.threadId } : {}),
      ...(entry.fin !== undefined ? { fin: entry.fin } : {}),
      bytes: entry.bytes,
      rttMs: Date.now() - entry.sentAt,
      ok: ack.ok,
      ...(ack.error !== undefined ? { error: ack.error } : {}),
    });
    entry.resolve(ack);
  };

  let failure: string | undefined;
  const fail = (why: string): void => {
    if (failure) {
      return;
    }
    failure = why;
    while (pending.length > 0) {
      const entry = pending.shift();
      if (entry) {
        settle(entry, { ok: false, error: why });
      }
    }
  };

  // Server pushes (lowered echoes, notices) carry a `kind`; per-frame acks never
  // do — so `kind` is the dispatch discriminator. Pushes never consume a pending
  // ack entry.
  const serverMessageHandlers: Array<(msg: ServerMessage) => void> = [];
  socket.addEventListener("message", (event: MessageEvent) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(event.data));
    } catch {
      parsed = { ok: false, error: "server sent invalid JSON" };
    }
    if (parsed !== null && typeof parsed === "object" && "kind" in parsed) {
      for (const handler of serverMessageHandlers) {
        handler(parsed as ServerMessage);
      }
      return;
    }
    const entry = pending.shift();
    if (entry) {
      settle(entry, parsed as Ack);
    }
  });
  socket.addEventListener("error", () => fail("websocket error"));

  // Set by the returned socket's own close() so the deliberate teardown after a
  // successful `fin` (or a cancel) is never reported as a fault; anything else
  // that closes an established socket — the channel process stopping, a reload
  // dropping every connection (code 1012), a network fault — IS one.
  let closedByClient = false;
  // Set once the hello ack lands: a close before that already surfaces through
  // the connect promise's rejection, so no synthetic error doubles it.
  let helloDone = false;
  socket.addEventListener("close", (event: { code?: number; reason?: string }) => {
    fail("connection closed");
    if (!helloDone || closedByClient) {
      return;
    }
    // An unexpected close is a failure only the client can observe — surface it
    // through the SAME path as a server-pushed error, so one handler (the
    // intent tool's toast column) covers both. The server's close reason
    // ("channel reload") rides along when it sent one. Note there is no
    // reconnect to report: the intent socket is deliberately one-per-thread
    // (stateless widget); the in-progress turn cannot be resumed, only redone.
    const reason = typeof event?.reason === "string" && event.reason !== "" ? event.reason : "";
    const synthetic: ErrorMessage = {
      kind: "error",
      source: "connection",
      message: `channel connection closed unexpectedly${reason ? ` (${reason})` : ""} — this turn was not sent`,
      detail:
        "The channel server stopped, reloaded, or dropped the socket. Check that `aiui claude`/`aiui vite` is still running, then re-send.",
    };
    for (const handler of serverMessageHandlers) {
      handler(synthetic);
    }
  });

  const sendFrame = (
    frame: Uint8Array,
    meta: Pick<Pending, "kind" | "threadId" | "fin">,
  ): Promise<Ack> => {
    if (failure) {
      return Promise.resolve({ ok: false, error: failure });
    }
    return new Promise((resolve) => {
      pending.push({ resolve, ...meta, bytes: frame.length, sentAt: Date.now() });
      socket.send(frame);
    });
  };

  return new Promise((resolve, reject) => {
    socket.addEventListener("error", () => reject(new Error(`could not connect to ${url}`)));
    socket.addEventListener("open", () => {
      sendFrame(
        encodeFrame({ v: PROTOCOL_VERSION, kind: "hello", format, ...(meta ? { meta } : {}) }),
        { kind: "hello" },
      ).then((ack) => {
        if (!ack.ok) {
          closedByClient = true; // our own teardown of a refused hello — not a fault
          socket.close();
          reject(new Error(ack.error ?? "hello rejected"));
          return;
        }
        helloDone = true;
        resolve({
          send: (threadId, payload, fin) =>
            sendFrame(
              encodeFrame(
                { v: PROTOCOL_VERSION, kind: "data", threadId, fin },
                payload === undefined ? undefined : encodeJsonPayload(payload),
              ),
              { kind: "data", threadId, fin },
            ),
          sendChunk: (threadId, chunk, payload, fin = false) =>
            sendFrame(
              encodeFrame(
                { v: PROTOCOL_VERSION, kind: "data", threadId, fin, chunk },
                payload === undefined ? undefined : encodeJsonPayload(payload),
              ),
              { kind: "data", threadId, fin },
            ),
          sendAttachment: (threadId, chunk, bytes, fin = false) =>
            sendFrame(
              // Raw bytes ride the payload verbatim — the whole reason the frame
              // format keeps the payload opaque and un-base64'd.
              encodeFrame({ v: PROTOCOL_VERSION, kind: "data", threadId, fin, chunk }, bytes),
              { kind: "data", threadId, fin },
            ),
          sendAudio: (threadId, chunk, bytes, fin = false) =>
            sendFrame(
              encodeFrame({ v: PROTOCOL_VERSION, kind: "data", threadId, fin, chunk }, bytes),
              { kind: "data", threadId, fin },
            ),
          onServerMessage: (handler) => {
            serverMessageHandlers.push(handler);
          },
          close: () => {
            closedByClient = true;
            socket.close();
          },
        });
      });
    });
  });
}
