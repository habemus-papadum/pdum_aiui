/**
 * protocol.ts — a minimal CDP wire client for the PAGE side (no deps): one
 * WebSocket in flat mode, id-correlated commands, method-keyed events. The
 * socket factory is injectable so tests script the far end; the real page
 * dials the channel's `/intent/cdp` proxy (same origin — the page never
 * touches the browser's debug port directly, and the proxy refuses
 * non-loopback endpoints server-side).
 */

/** The subset of WebSocket the client uses (jsdom/tests provide fakes). */
export interface CdpSocket {
  send(data: string): void;
  close(): void;
  addEventListener(type: "open" | "close" | "error", handler: () => void): void;
  addEventListener(type: "message", handler: (event: { data: unknown }) => void): void;
}

export interface CdpEvent {
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}

export interface CdpConnection {
  /** Send one command; resolves with the result, rejects on a CDP error. */
  send(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
  ): Promise<Record<string, unknown>>;
  /** Subscribe to protocol events (all sessions). Returns unsubscribe. */
  onEvent(handler: (event: CdpEvent) => void): () => void;
  /** Fired once when the socket closes (drop, dispose, proxy failure). */
  onClose(handler: () => void): () => void;
  close(): void;
}

const CONNECT_TIMEOUT_MS = 8000;

export async function connectCdp(
  url: string,
  socketFactory: (url: string) => CdpSocket = (u) => new WebSocket(u) as unknown as CdpSocket,
): Promise<CdpConnection> {
  const socket = socketFactory(url);
  let nextId = 1;
  const pending = new Map<
    number,
    { resolve: (result: Record<string, unknown>) => void; reject: (error: Error) => void }
  >();
  const eventHandlers = new Set<(event: CdpEvent) => void>();
  const closeHandlers = new Set<() => void>();
  let closed = false;

  socket.addEventListener("message", (event) => {
    let message: {
      id?: number;
      result?: Record<string, unknown>;
      error?: { message?: string };
      method?: string;
      params?: Record<string, unknown>;
      sessionId?: string;
    };
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (message.id !== undefined) {
      const waiter = pending.get(message.id);
      if (waiter !== undefined) {
        pending.delete(message.id);
        if (message.error !== undefined) {
          waiter.reject(new Error(message.error.message ?? "CDP error"));
        } else {
          waiter.resolve(message.result ?? {});
        }
      }
      return;
    }
    if (typeof message.method === "string") {
      const cdpEvent: CdpEvent = {
        method: message.method,
        params: message.params ?? {},
        ...(message.sessionId !== undefined ? { sessionId: message.sessionId } : {}),
      };
      for (const handler of eventHandlers) {
        handler(cdpEvent);
      }
    }
  });

  const settleClosed = (): void => {
    if (closed) {
      return;
    }
    closed = true;
    for (const [, waiter] of pending) {
      waiter.reject(new Error("CDP socket closed"));
    }
    pending.clear();
    for (const handler of closeHandlers) {
      handler();
    }
  };
  socket.addEventListener("close", settleClosed);

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("timed out connecting to the CDP proxy")),
      CONNECT_TIMEOUT_MS,
    );
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("could not open the CDP socket"));
    });
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      resolve();
    });
  });

  return {
    send(method, params = {}, sessionId) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        try {
          socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
        } catch (err) {
          pending.delete(id);
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    },
    onEvent(handler) {
      eventHandlers.add(handler);
      return () => eventHandlers.delete(handler);
    },
    onClose(handler) {
      closeHandlers.add(handler);
      return () => closeHandlers.delete(handler);
    },
    close() {
      socket.close();
      settleClosed();
    },
  };
}
