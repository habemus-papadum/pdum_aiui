/**
 * session.ts — the detached page's channel session: port resolution, the
 * /health probe, and the session-bus client (peers + shared slots) with a
 * simple reconnect loop.
 *
 * Port resolution, in order (the whole discovery story for a PLAIN page —
 * no native host, no chrome.storage):
 *  1. an explicit `port` (tests, embedding hosts);
 *  2. `?channel=<port>` in the page URL (the per-URL override / channel switcher);
 *  3. `VITE_AIUI_PORT` (the standalone dev launcher wires the chosen channel in —
 *     scripts/dev.ts — so the dev page, on Vite's own origin, can still drive one);
 *  4. the page's OWN origin (the endgame: the channel serves the panel, so
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
/**
 * The channel port the page should dial, in precedence order:
 *  1. an explicit argument (tests);
 *  2. `?channel=<port>` — the user's per-URL override (the channel switcher);
 *  3. `VITE_AIUI_PORT` — injected by the dev launcher (scripts/dev.ts) so the
 *     standalone Vite page can drive a channel it was NOT served by;
 *  4. same-origin `location.port` — when the CHANNEL served this page (`/intent/`
 *     via the sidecar), the port we're bound to IS the channel's.
 *
 * The env sits ABOVE same-origin deliberately. On the standalone dev page
 * `location.port` is *Vite's*, not a channel's, so trusting it dropped the page
 * to the fake tier — the confusion behind the "why do the two servings differ"
 * question. When the channel serves the page, `VITE_AIUI_PORT` is unset and
 * same-origin wins, exactly as before.
 */
export function resolveChannelPort(explicit?: number): number | undefined {
  if (explicit !== undefined) {
    return explicit;
  }
  if (typeof location !== "undefined") {
    const fromQuery = new URLSearchParams(location.search).get("channel");
    if (fromQuery !== null && /^\d+$/.test(fromQuery)) {
      return Number(fromQuery);
    }
  }
  const injected = injectedChannelPort();
  if (injected !== undefined) {
    return injected;
  }
  if (typeof location !== "undefined" && location.port !== "") {
    return Number(location.port); // same-origin: the channel served us
  }
  return undefined;
}

/** The channel port the dev launcher wired in via `VITE_AIUI_PORT` (scripts/dev.ts). */
function injectedChannelPort(): number | undefined {
  const raw: unknown = import.meta.env?.VITE_AIUI_PORT;
  return typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : undefined;
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
