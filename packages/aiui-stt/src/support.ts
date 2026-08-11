/**
 * support.ts — the vendor-agnostic session plumbing, ported from the
 * channel's `session-core.ts` (which distilled it from four live vendor
 * sessions): the injectable socket seam, the queue-until-ready send gate,
 * the drain controller, the failure fan-out, and base64 for wire frames.
 *
 * The one browser-shaped difference from the channel: sockets are the
 * platform `WebSocket` (auth rides the URL or a subprotocol — a browser
 * cannot set request headers), and there is no `unexpected-response` body
 * capture (the browser exposes only the close frame). What each vendor
 * says in its close frame therefore matters even more here; `closeSuffix`
 * keeps it in every fault message.
 */

/**
 * The minimal socket a session drives — a subset of `WebSocket`, so a test
 * supplies a scripted fake with no network.
 */
export interface SttSocket {
  send(text: string): void;
  close(): void;
}

/** Handlers the session hands the factory to observe the socket. */
export interface SttSocketHandlers {
  onOpen(): void;
  onMessage(text: string): void;
  onError(message: string): void;
  onClose(code?: number, reason?: string): void;
}

/**
 * Builds the socket for one session (the platform WebSocket in production, a
 * fake in tests). `protocols` is the browser's only header-free auth channel
 * (OpenAI's `openai-insecure-api-key.<ek_>` subprotocol rides here; Scribe
 * needs none — its token is a URL param).
 */
export type SttSocketFactory = (
  url: string,
  protocols: string[] | undefined,
  handlers: SttSocketHandlers,
) => SttSocket;

/** The real platform-WebSocket factory. */
export const browserSocketFactory: SttSocketFactory = (url, protocols, handlers) => {
  const socket = protocols === undefined ? new WebSocket(url) : new WebSocket(url, protocols);
  socket.addEventListener("open", () => handlers.onOpen());
  socket.addEventListener("message", (event) => handlers.onMessage(String(event.data)));
  // The browser's error event carries no detail; the close frame that follows
  // carries the vendor's actual reason, so onClose is where faults get words.
  socket.addEventListener("error", () => handlers.onError("websocket error"));
  socket.addEventListener("close", (event) => handlers.onClose(event.code, event.reason));
  return {
    send: (text) => socket.send(text),
    close: () => socket.close(),
  };
};

/**
 * Render a close frame's code/reason as a parenthesized suffix for a fault
 * message — `" (1007: API key not valid …)"` — or "" when neither exists.
 * The reason is where vendors state the actual error, so it leads the text.
 */
export function closeSuffix(code?: number, reason?: string): string {
  const trimmed = reason?.trim() ?? "";
  if (code === undefined && trimmed === "") {
    return "";
  }
  if (code === undefined) {
    return ` (${trimmed})`;
  }
  return trimmed === "" ? ` (${code})` : ` (${code}: ${trimmed})`;
}

/**
 * The queue-until-ready send gate. Frames sent before the vendor's ready
 * signal are buffered; `markReady()` flushes them in enqueue order. `onSent`
 * fires ONLY on a real socket send — never a buffered enqueue — because
 * Scribe arms its idle keepalive from real outbound frames (the channel's
 * recorded trap).
 */
export interface ReadyGate {
  send(text: string): void;
  markReady(): void;
  markDead(): void;
  isDead(): boolean;
}

export function createReadyGate(
  rawSend: (text: string) => void,
  opts?: { onSent?: () => void },
): ReadyGate {
  let ready = false;
  let dead = false;
  const outbox: string[] = [];
  const realSend = (text: string): void => {
    rawSend(text);
    opts?.onSent?.();
  };
  return {
    send(text) {
      if (ready && !dead) {
        realSend(text);
      } else if (!dead) {
        outbox.push(text);
      }
    },
    markReady() {
      ready = true;
      for (const queued of outbox.splice(0)) {
        realSend(queued);
      }
    },
    markDead() {
      dead = true;
    },
    isDead() {
      return dead;
    },
  };
}

/**
 * The drain controller: `drain(timeoutMs)` resolves when every outstanding
 * committed segment has produced its final, or the timeout elapses —
 * returning the ordinals STILL outstanding, snapshotted at RESOLUTION time.
 * `outstanding()` is read fresh on every call, so the snapshot reflects the
 * queue as it stands when the timer or the last settle fires.
 */
export interface DrainController {
  settleIfIdle(): void;
  drain(timeoutMs: number): Promise<number[]>;
  releaseAll(): void;
}

export function createDrainController(outstanding: () => number[]): DrainController {
  const waiters: Array<() => void> = [];
  return {
    settleIfIdle() {
      if (outstanding().length === 0) {
        for (const resolve of waiters.splice(0)) {
          resolve();
        }
      }
    },
    drain(timeoutMs) {
      if (outstanding().length === 0) {
        return Promise.resolve([]);
      }
      return new Promise<number[]>((resolve) => {
        let settled = false;
        const finish = (): void => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timer);
          resolve(outstanding());
        };
        const timer = setTimeout(finish, timeoutMs);
        waiters.push(finish);
      });
    },
    releaseAll() {
      for (const resolve of waiters.splice(0)) {
        resolve();
      }
    },
  };
}

/**
 * The shared tail of a session-wide failure: report the fault per
 * outstanding segment loudly (so the caller settles each one), or once
 * session-wide when nothing was in flight.
 */
export function reportSessionFailure(
  onError: (message: string, segment?: number) => void,
  message: string,
  segments: number[],
): void {
  for (const segment of segments) {
    onError(message, segment);
  }
  if (segments.length === 0) {
    onError(message);
  }
}

/**
 * Base64-encode raw bytes for a wire frame's audio field. Browser-safe
 * (`btoa` over chunks — no Buffer), and chunked so a large frame never
 * overflows the argument list.
 */
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
