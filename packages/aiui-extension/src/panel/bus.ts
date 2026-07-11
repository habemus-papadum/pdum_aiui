/**
 * A lean session-bus client for the panel: dial `ws://127.0.0.1:<port>/session`,
 * say hello as this window's view, and track peers + shared slots.
 *
 * The wire shapes are the channel's session hub (`aiui-claude-channel/src/
 * session-hub.ts` is the source of truth); the page-side sibling is the
 * overlay's `session-bus.ts`. This client is deliberately smaller than the
 * overlay's: no capability probe two-step (the panel probed `/health` before
 * ever constructing this), and the panel document is a stable host (measured:
 * no lifetime gaps), so reconnect is a simple timer. The message reducer is
 * pure and exported for tests.
 */

export interface BusPeer {
  clientId: string;
  role?: string;
  label?: string;
  url?: string;
}

export type BusPhase = "connecting" | "connected" | "closed";

/** The client's renderable state. Immutable — the reducer returns fresh objects. */
export interface BusState {
  phase: BusPhase;
  clientId?: string;
  peers: BusPeer[];
  slots: Record<string, unknown>;
}

export const INITIAL_BUS_STATE: BusState = { phase: "connecting", peers: [], slots: {} };

/** Apply one server message. Pure; unknown messages are ignored. */
export function reduceBusMessage(state: BusState, msg: unknown): BusState {
  if (msg === null || typeof msg !== "object") {
    return state;
  }
  const m = msg as Record<string, unknown>;
  if (m.type === "snapshot") {
    return {
      phase: "connected",
      clientId: typeof m.clientId === "string" ? m.clientId : undefined,
      peers: Array.isArray(m.peers) ? (m.peers as BusPeer[]) : [],
      slots: { ...state.slots, ...((m.state ?? {}) as Record<string, unknown>) },
    };
  }
  if (m.type === "peers" && Array.isArray(m.peers)) {
    return { ...state, peers: m.peers as BusPeer[] };
  }
  if (m.type === "set" && typeof m.slot === "string") {
    return { ...state, slots: { ...state.slots, [m.slot]: m.value } };
  }
  return state;
}

export interface SessionBusClient {
  state(): BusState;
  /** Fires after every state change (and once on connect). Returns unsubscribe. */
  onChange(handler: (state: BusState) => void): () => void;
  set(slot: string, value: unknown): void;
  publish(topic: string, payload?: unknown): void;
  close(): void;
}

const RECONNECT_MS = 3000;

export function connectSessionBus(opts: {
  port: number;
  label: string;
  role?: string;
}): SessionBusClient {
  let state = INITIAL_BUS_STATE;
  let socket: WebSocket | undefined;
  let closed = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  const handlers = new Set<(state: BusState) => void>();

  const emit = (next: BusState): void => {
    state = next;
    for (const handler of handlers) {
      handler(state);
    }
  };

  const send = (message: unknown): void => {
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  };

  const dial = (): void => {
    if (closed) {
      return;
    }
    emit({ ...state, phase: "connecting" });
    const ws = new WebSocket(`ws://127.0.0.1:${opts.port}/session`);
    socket = ws;
    ws.addEventListener("open", () => {
      send({
        v: 1,
        type: "hello",
        role: opts.role ?? "window",
        label: opts.label,
      });
    });
    ws.addEventListener("message", (event) => {
      try {
        emit(reduceBusMessage(state, JSON.parse(String(event.data))));
      } catch {
        // unparseable frame: ignore
      }
    });
    ws.addEventListener("close", () => {
      socket = undefined;
      if (!closed) {
        emit({ ...state, phase: "connecting", clientId: undefined, peers: [] });
        reconnectTimer = setTimeout(dial, RECONNECT_MS);
      }
    });
    ws.addEventListener("error", () => {
      // close fires next; the reconnect loop handles it
    });
  };

  dial();

  return {
    state: () => state,
    onChange(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    set(slot, value) {
      send({ v: 1, type: "set", slot, value });
    },
    publish(topic, payload) {
      send({ v: 1, type: "publish", topic, ...(payload !== undefined ? { payload } : {}) });
    },
    close() {
      closed = true;
      if (reconnectTimer !== undefined) {
        clearTimeout(reconnectTimer);
      }
      socket?.close();
      emit({ ...state, phase: "closed", clientId: undefined, peers: [] });
    },
  };
}
