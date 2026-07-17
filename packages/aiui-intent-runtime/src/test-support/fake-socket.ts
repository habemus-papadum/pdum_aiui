/**
 * Test support: a scriptable fake WebSocket for exercising the intent tool
 * without a server. Lives outside the build/typecheck graph (see tsconfig
 * `exclude`) — test-only code.
 */
import type { Ack, WebSocketLike } from "../protocol";

/** A fake WebSocket factory: acks every frame, records what was sent. */
export function fakeSocketFactory(ackFor: (frame: Uint8Array, index: number) => Ack) {
  const sent: Uint8Array[] = [];
  const listeners = new Map<string, Array<(event: unknown) => void>>();
  const emit = (type: string, event: unknown) => {
    for (const fn of listeners.get(type) ?? []) {
      fn(event);
    }
  };
  const socket: WebSocketLike = {
    binaryType: "blob",
    send(frame: Uint8Array) {
      const index = sent.length;
      sent.push(frame);
      queueMicrotask(() => emit("message", { data: JSON.stringify(ackFor(frame, index)) }));
    },
    close() {
      emit("close", {});
    },
    addEventListener(type: string, listener: (event: never) => void) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener as (event: unknown) => void]);
    },
  };
  const factory = (_url: string) => {
    queueMicrotask(() => emit("open", {}));
    return socket;
  };
  /** Simulate a server → client push (a message not paired with a send). */
  const push = (message: unknown): void => {
    emit("message", { data: JSON.stringify(message) });
  };
  /**
   * Simulate a SERVER-initiated close (the channel stopping, or a reload
   * dropping every socket with 1012) — distinct from the client's own
   * `close()`, which the protocol must NOT report as a fault.
   */
  const drop = (code = 1012, reason = "channel reload"): void => {
    emit("close", { code, reason });
  };
  return { factory, sent, push, drop };
}
