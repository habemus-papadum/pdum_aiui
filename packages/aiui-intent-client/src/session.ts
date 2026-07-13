/**
 * session.ts — the detached page's channel session: port resolution, the
 * /health probe, and the session-bus client (peers + shared slots) with a
 * simple reconnect loop.
 *
 * Port resolution, in order (the whole discovery story for a PLAIN page —
 * no native host, no chrome.storage):
 *  1. an explicit `port` (tests, embedding hosts);
 *  2. `?channel=<port>` in the page URL (the dev workflow);
 *  3. the page's OWN origin (the endgame: the channel serves the panel, so
 *     the page's origin IS the channel and discovery disappears).
 *
 * The bus shapes mirror the channel's session hub (`aiui-claude-channel`
 * session-hub.ts); the reducer is pure and exported for tests — this is the
 * old panel's bus.ts (salvage list: "pure — copy"), chrome-free as promised.
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

/** Resolve the channel port for this page (see the module doc for the order). */
export function resolveChannelPort(explicit?: number): number | undefined {
  if (explicit !== undefined) {
    return explicit;
  }
  if (typeof location !== "undefined") {
    const fromQuery = new URLSearchParams(location.search).get("channel");
    if (fromQuery !== null && /^\d+$/.test(fromQuery)) {
      return Number(fromQuery);
    }
    if (location.port !== "") {
      return Number(location.port); // same-origin: the channel served us
    }
  }
  return undefined;
}

/** What `/health` answers (the fields this page uses). */
export interface ChannelHealth {
  ok: boolean;
  /** Present iff the channel has the session bus — the capability gate. */
  session?: unknown;
  /** A standalone `aiui serve` — reachable but with no Claude session. */
  debug?: boolean;
}

/** Probe one port. `undefined` = not a (reachable) channel. */
export async function probeChannel(port: number): Promise<ChannelHealth | undefined> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) {
      return undefined;
    }
    const body = (await res.json()) as ChannelHealth;
    return body.ok === true ? body : undefined;
  } catch {
    return undefined;
  }
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

/** Dial the channel's session hub and keep dialing. */
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
      send({ v: 1, type: "hello", role: opts.role ?? "intent-client", label: opts.label });
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
