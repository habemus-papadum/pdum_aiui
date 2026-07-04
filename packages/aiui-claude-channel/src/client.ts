/**
 * The channel client library.
 *
 * Lets a program push messages into a running channel server over the binary
 * `/ws` protocol without touching the wire format: connect declaring a stream
 * format, open threads (client-generated ids), and `send`/`finish` payloads.
 * The client encodes each payload with the format's codec, wraps it in the
 * {@link ./frame} envelope, and sends one binary WebSocket frame — so audio,
 * screenshots, and video ride through as raw bytes, never base64.
 *
 * This is the reference client the CLI (`quick --ws`, via send-ws.ts) and the
 * e2e test drive. It runs on Node's `ws`; the framing/codec modules it builds
 * on are browser-safe, so a browser client can speak the same protocol with
 * the native `WebSocket`.
 */
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import type { ChannelResponse } from "./channel";
import { jsonCodec, type PayloadCodec } from "./codec";
import { encodeFrame, PROTOCOL_VERSION } from "./frame";

export interface ChannelClientOptions {
  /** The server's websocket URL, e.g. `ws://127.0.0.1:<port>/ws`. */
  url: string;
  /** Stream format to declare in the hello (must be one the server knows). */
  format: string;
  /**
   * Codec used to encode payloads — must match what the server's format
   * decodes with. Defaults to {@link jsonCodec} (right for text formats like
   * `text-concat`); pass {@link rawCodec} for binary media formats.
   */
  codec?: PayloadCodec;
}

/** A single client-owned thread of messages. */
export interface ChannelThread {
  /** The client-generated id carried by this thread's frames. */
  readonly id: string;
  /** Send one payload as a (non-final) `data` frame; resolves with the ack. */
  send(payload: unknown): Promise<ChannelResponse>;
  /**
   * Send a final `data` frame (`fin`), optionally with a last payload, and
   * resolve with the ack. After this the server rejects further frames for
   * this thread.
   */
  finish(payload?: unknown): Promise<ChannelResponse>;
}

/** A live connection to a channel server. */
export interface ChannelClient {
  /** Open a new thread; pass an id to use your own, else a UUID is generated. */
  openThread(threadId?: string): ChannelThread;
  /** Close the underlying websocket. */
  close(): Promise<void>;
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Connect to a channel server and complete the hello handshake. Resolves once
 * the server has accepted the format; rejects if the connection fails or the
 * server rejects the hello.
 */
export function connectChannelClient(options: ChannelClientOptions): Promise<ChannelClient> {
  const codec = options.codec ?? jsonCodec;
  const socket = new WebSocket(options.url);
  socket.binaryType = "arraybuffer";

  // Acks come back one-per-frame, in the order frames were sent, so a FIFO of
  // resolvers pairs each reply with its request.
  const pending: Array<(response: ChannelResponse) => void> = [];
  let failure: Error | undefined;

  const fail = (err: Error): void => {
    if (failure) {
      return;
    }
    failure = err;
    while (pending.length > 0) {
      // Surface the transport failure as a failed ack rather than a hang.
      pending.shift()?.({ ok: false, error: err.message });
    }
  };

  socket.on("message", (data, isBinary) => {
    // Server → client acks are small JSON text frames.
    const text = isBinary ? Buffer.from(data as ArrayBuffer).toString() : data.toString();
    let response: ChannelResponse;
    try {
      response = JSON.parse(text) as ChannelResponse;
    } catch {
      response = { ok: false, error: "server sent invalid JSON" };
    }
    pending.shift()?.(response);
  });
  socket.on("error", (err) => fail(err instanceof Error ? err : new Error(String(err))));
  socket.on("close", () => fail(new Error("connection closed")));

  // Queue a frame's ack resolver and send the frame; rejects fast if the
  // socket has already failed.
  const sendFrame = (frame: Uint8Array): Promise<ChannelResponse> => {
    if (failure) {
      return Promise.resolve({ ok: false, error: failure.message });
    }
    return new Promise<ChannelResponse>((resolve) => {
      pending.push(resolve);
      socket.send(frame, (err) => {
        if (err) {
          fail(err);
        }
      });
    });
  };

  return new Promise<ChannelClient>((resolve, reject) => {
    socket.once("error", (err) =>
      reject(err instanceof Error ? err : new Error(errorMessage(err))),
    );
    socket.on("open", () => {
      sendFrame(encodeFrame({ v: PROTOCOL_VERSION, kind: "hello", format: options.format })).then(
        (ack) => {
          if (!ack.ok) {
            socket.close();
            reject(new Error(ack.error ?? "hello rejected"));
            return;
          }
          resolve({
            openThread(threadId = randomUUID()): ChannelThread {
              const dataFrame = (payload: unknown, fin: boolean): Uint8Array =>
                encodeFrame(
                  { v: PROTOCOL_VERSION, kind: "data", threadId, fin },
                  payload === undefined ? undefined : codec.encode(payload),
                );
              return {
                id: threadId,
                send: (payload) => sendFrame(dataFrame(payload, false)),
                finish: (payload) => sendFrame(dataFrame(payload, true)),
              };
            },
            close: () =>
              new Promise<void>((resolveClose) => {
                if (socket.readyState === WebSocket.CLOSED) {
                  resolveClose();
                  return;
                }
                socket.once("close", () => resolveClose());
                socket.close();
              }),
          });
        },
      );
    });
  });
}
