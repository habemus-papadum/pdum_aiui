/**
 * The session bus (browser side): a persistent connection to the channel's
 * `/session` endpoint that lets multiple views of ONE session — the app tab, the
 * VS Code bridge, a future git viewer — share state and talk to each other.
 *
 * The channel process is the session (one per Claude Code session, one port), so
 * every view that dials this port is a peer. This client mirrors {@link
 * installToolsBridge}'s shape — a `/health` capability probe (the browser logs a
 * failed websocket handshake unsuppressably, so never dial blind), then a dialed
 * socket with reconnect — and exposes a tiny pub/sub:
 *
 *  - **shared state** — `set(slot, value)` writes a last-writer-wins slot the hub
 *    caches and broadcasts; `on(slot, cb)` fires on every change (and once per
 *    slot when the join snapshot lands, so a late view catches up); `get(slot)`
 *    reads the cache. This is how `armed` and the prompt `preview` stay in sync.
 *  - **transient publishes** — `publish(topic, payload)` fans a one-shot message
 *    out to the other views (a code selection contributed to the turn);
 *    `onPublish(topic, cb)` receives them. Not cached.
 *  - **peers** — `peers()` / `onPeers(cb)`: who else is connected.
 *
 * `on`/`onPublish` do NOT fire on registration from the cache — register early,
 * then read `get()` (or wait for the snapshot, which replays slots through the
 * handlers). A handler that reacts to a slot MUST NOT blindly re-`set` it, or two
 * views ping-pong forever; apply the remote value, don't rebroadcast it.
 *
 * Dependency-free and browser-only; the websocket is injectable for tests
 * (`opts.socketFactory`). Safe to call unconditionally: with no channel port it
 * installs nothing and returns a no-op disposer.
 */
import { collectClientMeta, getInstrumentation } from "./instrumentation";

/** What a connected peer told the hub about itself. */
export interface SessionPeer {
  clientId: string;
  role?: string;
  label?: string;
  url?: string;
}

/** The page-facing API installed at `window.__AIUI__.session`. */
export interface SessionBusApi {
  /** Write a last-writer-wins shared slot (cached + broadcast to other views). */
  set(slot: string, value: unknown): void;
  /** The current cached value of a slot, or undefined. */
  get(slot: string): unknown;
  /** Subscribe to a slot's changes (and the join snapshot). Returns an unsubscribe. */
  on(slot: string, handler: (value: unknown, from: string) => void): () => void;
  /** Fan a transient message out to the other views (not cached). */
  publish(topic: string, payload?: unknown): void;
  /** Receive transient messages on a topic. Returns an unsubscribe. */
  onPublish(topic: string, handler: (payload: unknown, from: string) => void): () => void;
  /** The peers currently connected (excludes self). */
  peers(): SessionPeer[];
  /** Subscribe to peer-list changes. Returns an unsubscribe. */
  onPeers(handler: (peers: SessionPeer[]) => void): () => void;
  /** Whether the socket is connected and the join snapshot has landed. */
  ready(): boolean;
  /** Fire once when the connection is ready (or immediately if already ready). */
  onReady(handler: () => void): () => void;
  /** This view's server-assigned client id, once connected. */
  clientId(): string | undefined;
}

export interface SessionBusOptions {
  /** What kind of view this is: `app`, `code`, `git`, `ipad`, …. Rides the hello. */
  role?: string;
  /** A short human label for the peer list; defaults to `document.title`. */
  label?: string;
  /** Channel port; defaults to the plugin-injected `window.__AIUI__.port`. */
  port?: number;
  /** Test hook: replaces the global `WebSocket` with a fake. */
  socketFactory?: SessionSocketFactory;
  /** Test hook / override: replaces the `/health` capability probe. */
  probe?: SessionProbe;
}

/** What the capability probe learned about the channel server. */
export type SessionProbeResult =
  /** `/health` advertises the session bus — safe to dial `/session`. */
  | "session"
  /** The server answered but predates `/session` (older channel build). */
  | "no-session"
  /** Nothing answered. */
  | "unreachable";

export type SessionProbe = () => SessionProbeResult | Promise<SessionProbeResult>;

/** The subset of `WebSocket` the bus uses (JSON text frames) — injectable. */
export interface SessionSocketLike {
  send(data: string): void;
  close(): void;
  addEventListener(type: string, listener: (event: never) => void): void;
}

export type SessionSocketFactory = (url: string) => SessionSocketLike;

declare module "./instrumentation" {
  interface PageInstrumentation {
    /** The session bus, once {@link installSessionBus} ran. */
    session?: SessionBusApi;
  }
}

const RECONNECT_MS = 3000;
const PROBE_ATTEMPTS = 3;
const BUS_MARK = "__aiuiSessionBus";

const defaultFactory: SessionSocketFactory = (url) =>
  new WebSocket(url) as unknown as SessionSocketLike;

/**
 * The default capability probe: `GET /health` and look for the `session` summary
 * a `/session`-capable channel includes. Two-stage like the tools bridge's probe
 * (a `no-cors` reachability fetch, then the readable one) for console hygiene.
 */
const defaultProbe =
  (port: number): SessionProbe =>
  async () => {
    const url = `http://127.0.0.1:${port}/health`;
    try {
      await fetch(url, { mode: "no-cors" });
    } catch {
      return "unreachable";
    }
    try {
      const res = await fetch(url);
      if (!res.ok) {
        return "no-session";
      }
      const body: unknown = await res.json();
      return body !== null && typeof body === "object" && "session" in body
        ? "session"
        : "no-session";
    } catch {
      return "no-session";
    }
  };

function resolvePort(option: number | undefined): number | undefined {
  const injected = typeof window === "undefined" ? undefined : window.__AIUI__?.port;
  const port = Number(option ?? injected);
  return Number.isInteger(port) && port > 0 ? port : undefined;
}

/**
 * Install the session bus on the current page. Idempotent — a second call
 * returns the first install's disposer. No-ops (returns a no-op disposer)
 * without a DOM or a resolvable channel port, so it is safe to call
 * unconditionally.
 */
export function installSessionBus(opts: SessionBusOptions = {}): () => void {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return () => {};
  }
  const port = resolvePort(opts.port);
  if (port === undefined) {
    return () => {};
  }
  const inst = getInstrumentation();
  if (!inst) {
    return () => {};
  }
  const existing = inst.session as (SessionBusApi & { [BUS_MARK]?: () => void }) | undefined;
  if (existing?.[BUS_MARK]) {
    return existing[BUS_MARK] as () => void;
  }

  const factory = opts.socketFactory ?? defaultFactory;
  const url = `ws://127.0.0.1:${port}/session`;

  const slotHandlers = new Map<string, Set<(value: unknown, from: string) => void>>();
  const topicHandlers = new Map<string, Set<(payload: unknown, from: string) => void>>();
  const peerHandlers = new Set<(peers: SessionPeer[]) => void>();
  const readyHandlers = new Set<() => void>();
  const cache = new Map<string, unknown>();
  let peerList: SessionPeer[] = [];
  let myClientId: string | undefined;

  let socket: SessionSocketLike | undefined;
  let connected = false; // socket open
  let isReady = false; // snapshot landed
  let disposed = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  const raw = (message: unknown): void => {
    if (!socket || !connected) {
      return;
    }
    try {
      socket.send(JSON.stringify(message));
    } catch {
      // A send racing a close is dropped (nothing queues it); the reconnect's
      // snapshot re-syncs shared state, so views converge on the hub's view.
    }
  };

  const emitSlot = (slot: string, value: unknown, from: string): void => {
    cache.set(slot, value);
    for (const cb of slotHandlers.get(slot) ?? []) {
      cb(value, from);
    }
  };

  const handleMessage = (event: MessageEvent): void => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") {
      return;
    }
    if (msg.type === "snapshot") {
      myClientId = typeof msg.clientId === "string" ? msg.clientId : undefined;
      const state = (msg.state ?? {}) as Record<string, unknown>;
      for (const [slot, value] of Object.entries(state)) {
        emitSlot(slot, value, "snapshot");
      }
      peerList = Array.isArray(msg.peers) ? (msg.peers as SessionPeer[]) : [];
      for (const cb of peerHandlers) {
        cb(peerList);
      }
      if (!isReady) {
        isReady = true;
        for (const cb of readyHandlers) {
          cb();
        }
      }
    } else if (msg.type === "set" && typeof msg.slot === "string") {
      emitSlot(msg.slot, msg.value, typeof msg.from === "string" ? msg.from : "");
    } else if (msg.type === "publish" && typeof msg.topic === "string") {
      const from = typeof msg.from === "string" ? msg.from : "";
      for (const cb of topicHandlers.get(msg.topic) ?? []) {
        cb(msg.payload, from);
      }
    } else if (msg.type === "peers" && Array.isArray(msg.peers)) {
      peerList = msg.peers as SessionPeer[];
      for (const cb of peerHandlers) {
        cb(peerList);
      }
    }
  };

  const sendHello = (): void => {
    const meta = collectClientMeta();
    raw({
      v: 1,
      type: "hello",
      ...(opts.role !== undefined ? { role: opts.role } : {}),
      label: opts.label ?? (typeof document !== "undefined" ? document.title : "") ?? "",
      ...(typeof location !== "undefined" ? { url: location.href } : {}),
      ...(meta?.tab ? { tab: meta.tab } : {}),
    });
  };

  const scheduleAttempt = (attemptsLeft: number): void => {
    if (disposed || reconnectTimer !== undefined) {
      return;
    }
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      attempt(attemptsLeft);
    }, RECONNECT_MS);
  };

  const dial = (): void => {
    if (disposed) {
      return;
    }
    let ws: SessionSocketLike;
    try {
      ws = factory(url);
    } catch {
      scheduleAttempt(PROBE_ATTEMPTS);
      return;
    }
    socket = ws;
    ws.addEventListener("open", (() => {
      connected = true;
      sendHello();
    }) as (event: never) => void);
    ws.addEventListener("message", handleMessage as (event: never) => void);
    ws.addEventListener("close", (() => {
      connected = false;
      isReady = false;
      socket = undefined;
      scheduleAttempt(PROBE_ATTEMPTS);
    }) as (event: never) => void);
    ws.addEventListener("error", (() => {}) as (event: never) => void);
  };

  const probe = opts.probe ?? defaultProbe(port);

  const handleProbe = (status: SessionProbeResult, attemptsLeft: number): void => {
    if (disposed) {
      return;
    }
    if (status === "session") {
      dial();
    } else if (status === "no-session") {
      console.debug(
        "aiui: channel has no /session endpoint (older build) — session bus stays local",
      );
    } else if (attemptsLeft > 1) {
      scheduleAttempt(attemptsLeft - 1);
    }
  };

  const attempt = (attemptsLeft: number): void => {
    if (disposed) {
      return;
    }
    let result: SessionProbeResult | Promise<SessionProbeResult>;
    try {
      result = probe();
    } catch {
      handleProbe("unreachable", attemptsLeft);
      return;
    }
    if (typeof result === "string") {
      handleProbe(result, attemptsLeft);
    } else {
      result.then(
        (status) => handleProbe(status, attemptsLeft),
        () => handleProbe("unreachable", attemptsLeft),
      );
    }
  };

  const api: SessionBusApi & { [BUS_MARK]?: () => void } = {
    set(slot, value) {
      cache.set(slot, value); // local read-your-writes; the hub echoes to others
      raw({ v: 1, type: "set", slot, value });
    },
    get(slot) {
      return cache.get(slot);
    },
    on(slot, handler) {
      let set = slotHandlers.get(slot);
      if (!set) {
        set = new Set();
        slotHandlers.set(slot, set);
      }
      set.add(handler);
      return () => set?.delete(handler);
    },
    publish(topic, payload) {
      raw({ v: 1, type: "publish", topic, ...(payload !== undefined ? { payload } : {}) });
    },
    onPublish(topic, handler) {
      let set = topicHandlers.get(topic);
      if (!set) {
        set = new Set();
        topicHandlers.set(topic, set);
      }
      set.add(handler);
      return () => set?.delete(handler);
    },
    peers() {
      return peerList.filter((p) => p.clientId !== myClientId);
    },
    onPeers(handler) {
      peerHandlers.add(handler);
      return () => peerHandlers.delete(handler);
    },
    ready() {
      return isReady;
    },
    onReady(handler) {
      if (isReady) {
        handler();
        return () => {};
      }
      readyHandlers.add(handler);
      return () => readyHandlers.delete(handler);
    },
    clientId() {
      return myClientId;
    },
  };

  const dispose = (): void => {
    disposed = true;
    if (reconnectTimer !== undefined) {
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
    }
    if (socket) {
      try {
        socket.close();
      } catch {
        // already gone
      }
    }
    socket = undefined;
    connected = false;
    isReady = false;
    if (inst.session === api) {
      inst.session = undefined;
    }
  };
  api[BUS_MARK] = dispose;

  inst.session = api;
  attempt(PROBE_ATTEMPTS);

  return dispose;
}
