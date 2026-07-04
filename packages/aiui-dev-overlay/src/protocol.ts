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
  /** Send one data frame for a thread; resolves with the server's ack. */
  send(threadId: string, payload: unknown, fin: boolean): Promise<Ack>;
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

  socket.addEventListener("message", (event: MessageEvent) => {
    let ack: Ack;
    try {
      ack = JSON.parse(String(event.data)) as Ack;
    } catch {
      ack = { ok: false, error: "server sent invalid JSON" };
    }
    const entry = pending.shift();
    if (entry) {
      settle(entry, ack);
    }
  });
  socket.addEventListener("error", () => fail("websocket error"));
  socket.addEventListener("close", () => fail("connection closed"));

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
          socket.close();
          reject(new Error(ack.error ?? "hello rejected"));
          return;
        }
        resolve({
          send: (threadId, payload, fin) =>
            sendFrame(
              encodeFrame(
                { v: PROTOCOL_VERSION, kind: "data", threadId, fin },
                payload === undefined ? undefined : encodeJsonPayload(payload),
              ),
              { kind: "data", threadId, fin },
            ),
          close: () => socket.close(),
        });
      });
    });
  });
}
