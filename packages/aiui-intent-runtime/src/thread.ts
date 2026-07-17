/**
 * The intent-thread adapter, host-agnostic: connect an {@link IntentSocket}
 * and wrap it as one {@link IntentThread} — a fresh thread id, the per-thread
 * send/finish/chunk/attachment/audio/video verbs, and thread-filtered server
 * pushes. Host-agnostic so every host of the same wire (`wire.ts`) — the CDP
 * tier, the MV3 side panel — opens threads through ONE implementation instead
 * of a hand-rolled twin. Everything host-specific stays with the host: meta
 * collection (page instrumentation vs tab identity), connect-failure
 * surfacing, and any extra raw-socket listeners ride the `onSocket` hook.
 */
import type { ClientMeta } from "./instrumentation";
import type { IntentThread } from "./intent-types";
import { connectIntentSocket, type IntentSocket, type WebSocketFactory } from "./protocol";

export interface OpenIntentThreadOptions {
  /** The channel's websocket endpoint, e.g. `ws://127.0.0.1:52424/ws`. */
  url: string;
  /** The wire stream format (the server must know it), e.g. `intent-v1`. */
  format: string;
  /** Hello metadata (tab identity, actor, effective intent config…). */
  meta?: ClientMeta;
  /** Test hook: replaces the global `WebSocket`. */
  webSocketFactory?: WebSocketFactory;
  /**
   * Called with the RAW socket once connected, before the thread wrapper is
   * returned — the place for connection-level listeners (error pushes carry
   * no threadId and would be filtered by the wrapper's routing).
   */
  onSocket?: (socket: IntentSocket) => void;
}

/** Connect and wrap one thread. Rejects when the connect/hello fails. */
export async function openIntentThread(options: OpenIntentThreadOptions): Promise<IntentThread> {
  const socket = await connectIntentSocket(
    options.url,
    options.format,
    options.webSocketFactory,
    options.meta,
  );
  options.onSocket?.(socket);
  const threadId =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `t-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return {
    send: (payload) => socket.send(threadId, payload, false),
    finish: async (payload) => {
      const ack = await socket.send(threadId, payload, true);
      socket.close();
      return ack;
    },
    sendChunk: (chunk, payload, fin = false) => socket.sendChunk(threadId, chunk, payload, fin),
    sendAttachment: (chunk, bytes, fin = false) =>
      socket.sendAttachment(threadId, chunk, bytes, fin),
    sendAudio: (chunk, bytes, fin = false) => socket.sendAudio(threadId, chunk, bytes, fin),
    sendVideo: (chunk, bytes, fin = false) => socket.sendVideo(threadId, chunk, bytes, fin),
    onServerMessage: (handler) =>
      socket.onServerMessage((msg) => {
        // Route only this thread's pushes (the server may omit threadId for
        // connection-level notices — deliver those too).
        if (msg.threadId === undefined || msg.threadId === threadId) {
          handler(msg);
        }
      }),
    close: () => socket.close(),
  };
}
