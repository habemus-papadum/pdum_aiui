/**
 * The page → channel tools bridge (browser side).
 *
 * A page under development declares the tools it exposes to an agent —
 * name/description/JSON-Schema plus the implementing function — and this bridge
 * forwards the *schemas* to the aiui channel's `/tools` websocket, where the
 * Claude Code session sees them as MCP tools (`page_tools_list` /
 * `page_tools_call`). When the agent calls one, the channel routes it back here
 * and the bridge invokes the live function, returning its result the same way.
 *
 * Three properties, mirroring the handoff's recommendations
 * (`handoff/frontend-tool-registry.md`):
 *  - **Declarative registration.** `register(ns, tools)` declares the *whole*
 *    current set for a namespace; the server is keyed by (connection, ns) and
 *    replaces the entry. HMR/reloads just re-declare.
 *  - **Content-hashed forwarding.** Each declaration carries a page-computed
 *    hash of the schema-relevant fields; the server logs (and the MCP tool list
 *    changes) only when the hash changes, so a reload with an unchanged tool
 *    set is invisible upstream.
 *  - **Call-time resolution.** Incoming calls resolve the implementing function
 *    from the *latest* registered set at call time — HMR swapping every closure
 *    changes nothing observable.
 *  - **Console-quiet by construction.** The browser logs every failed WebSocket
 *    handshake as an unsuppressable console error, so the bridge probes
 *    `/health` (a caught fetch — silent against any reachable server) and only
 *    dials `/tools` when the payload advertises it. Against an older channel
 *    build it prints one debug line and goes dormant for the page load.
 *
 * Dependency-free and browser-only; the websocket is injectable for tests
 * (`opts.socketFactory`), the same seam protocol.ts uses. Safe to call
 * unconditionally: with no channel port it installs nothing and returns a
 * no-op disposer.
 */
import { collectClientMeta, getInstrumentation } from "./instrumentation";

/** A tool a page exposes: MCP schema fields plus the function that runs it. */
export interface BridgeTool {
  name: string;
  description: string;
  /** JSON Schema (draft 2020-12 object schema) for the arguments, when any. */
  inputSchema?: Record<string, unknown>;
  /** The implementation. Resolved fresh at call time; may be async. */
  run: (args?: unknown) => unknown | Promise<unknown>;
}

/** The page-facing API installed at `window.__AIUI__.tools`. */
export interface ToolsBridgeApi {
  /** Declare (replacing) the full tool set for one page namespace. */
  register(ns: string, tools: BridgeTool[]): void;
}

/** Options for {@link installToolsBridge}. */
export interface ToolsBridgeOptions {
  /** Channel port; defaults to the plugin-injected `window.__AIUI__.port`. */
  port?: number;
  /** Test hook: replaces the global `WebSocket` with a fake. */
  socketFactory?: ToolsSocketFactory;
  /** Test hook / override: replaces the `/health` capability probe. */
  probe?: ToolsProbe;
}

/** What the capability probe learned about the channel server. */
export type ToolsProbeResult =
  /** `/health` advertises the page-tools registry — safe to dial `/tools`. */
  | "tools"
  /** The server answered but predates `/tools` (older channel build). */
  | "no-tools"
  /** Nothing answered. */
  | "unreachable";

/** The capability probe. May be synchronous (tests) or async (the default). */
export type ToolsProbe = () => ToolsProbeResult | Promise<ToolsProbeResult>;

/** The subset of `WebSocket` the bridge uses (JSON text frames) — injectable. */
export interface ToolsSocketLike {
  send(data: string): void;
  close(): void;
  addEventListener(type: string, listener: (event: never) => void): void;
}

/** Constructs a {@link ToolsSocketLike} — the browser's `WebSocket` by default. */
export type ToolsSocketFactory = (url: string) => ToolsSocketLike;

/** The schema-only view of a tool that goes on the wire (no function). */
interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
}

// Add the bridge API to the shared page instrumentation type without editing
// instrumentation.ts (declaration merging keeps the ownership boundary clean).
declare module "./instrumentation" {
  interface PageInstrumentation {
    /** The page → channel tools bridge, once {@link installToolsBridge} ran. */
    tools?: ToolsBridgeApi;
  }
}

/** How long to wait before retrying a dropped/failed connection. */
const RECONNECT_MS = 3000;

/**
 * Probe attempts per connection episode before the bridge goes dormant. An
 * unreachable `fetch` prints one network-error line in the console (the
 * browser logs it even when caught), so episodes must be bounded — and a
 * dormant bridge costs nothing: a new channel session means a new port, which
 * only reaches the page via a reload that starts a fresh episode anyway.
 */
const PROBE_ATTEMPTS = 3;

/** The document event fired once the bridge API is installed. */
const READY_EVENT = "aiui:tools-ready";

/** Marker stashed on the installed API so a second install is a no-op. */
const BRIDGE_MARK = "__aiuiBridge";

const defaultFactory: ToolsSocketFactory = (url) =>
  new WebSocket(url) as unknown as ToolsSocketLike;

/**
 * The default capability probe: `GET /health` and look for the `pageTools`
 * summary the `/tools`-capable channel includes in its payload. The point is
 * console hygiene — the browser logs every failed WebSocket handshake as an
 * unsuppressable error, so the bridge must never dial blind.
 *
 * The probe is cross-origin (app dev server → channel port), in two stages:
 * a `no-cors` fetch first, which settles reachability and can never be
 * CORS-blocked, then the readable fetch. `/tools`-capable channels serve
 * `/health` with a permissive CORS header, so on them both stages are silent
 * and the payload is readable; a channel old enough to lack the header is by
 * the same token old enough to lack `/tools`, so a CORS-refused second stage
 * reads as `"no-tools"` (at the cost of the browser's one CORS console line —
 * gone after the channel restarts onto current code). Only a port nobody is
 * listening on reports `"unreachable"`, bounded by {@link PROBE_ATTEMPTS}.
 */
const defaultProbe =
  (port: number): ToolsProbe =>
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
        return "no-tools";
      }
      const body: unknown = await res.json();
      return body !== null && typeof body === "object" && "pageTools" in body
        ? "tools"
        : "no-tools";
    } catch {
      return "no-tools";
    }
  };

/** Resolve the channel port: explicit option, else `window.__AIUI__.port`. */
function resolvePort(option: number | undefined): number | undefined {
  const injected = typeof window === "undefined" ? undefined : window.__AIUI__?.port;
  const port = Number(option ?? injected);
  return Number.isInteger(port) && port > 0 ? port : undefined;
}

/** Deterministic JSON with sorted object keys, so the hash is order-stable. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(",")}}`;
}

/** 32-bit FNV-1a of a string, as 8 hex chars. */
function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Content hash of a tool set's schema-relevant fields (name, description,
 * inputSchema — never the function), invariant to tool order and object key
 * order. Two declarations with the same schemas hash identically, which is what
 * makes reloads invisible upstream.
 */
export function canonicalToolsHash(tools: ToolDescriptor[]): string {
  const canonical = tools
    .map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema ?? null }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return fnv1a(stableStringify(canonical));
}

/** Drop the `run` function, keeping only what the channel needs. */
const toDescriptor = (t: BridgeTool): ToolDescriptor => ({
  name: t.name,
  description: t.description,
  ...(t.inputSchema ? { inputSchema: t.inputSchema } : {}),
});

/** Best-effort JSON round-trip: `undefined` → `null`, throws on circular. */
const toJsonSafe = (value: unknown): unknown =>
  value === undefined ? null : JSON.parse(JSON.stringify(value));

/**
 * Install the tools bridge on the current page. Idempotent — a second call
 * returns the first install's disposer. No-ops (returns a no-op disposer)
 * without a DOM or without a resolvable channel port, so it is safe to call
 * unconditionally.
 */
export function installToolsBridge(opts: ToolsBridgeOptions = {}): () => void {
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
  const existing = inst.tools as (ToolsBridgeApi & { [BRIDGE_MARK]?: () => void }) | undefined;
  if (existing?.[BRIDGE_MARK]) {
    return existing[BRIDGE_MARK] as () => void;
  }

  const factory = opts.socketFactory ?? defaultFactory;
  const url = `ws://127.0.0.1:${port}/tools`;
  // ns → the latest declared set. Calls resolve `run` out of this at call time,
  // so an HMR swap that replaces every closure is invisible.
  const registry = new Map<string, BridgeTool[]>();

  let socket: ToolsSocketLike | undefined;
  let connected = false;
  let disposed = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  const send = (message: unknown): void => {
    if (!socket || !connected) {
      return;
    }
    try {
      socket.send(JSON.stringify(message));
    } catch {
      // A send racing a close just gets retried on the next (re)connect.
    }
  };

  const sendRegister = (ns: string, tools: BridgeTool[]): void => {
    const descriptors = tools.map(toDescriptor);
    const meta = collectClientMeta();
    send({
      v: 1,
      type: "register",
      ns,
      ...(typeof location !== "undefined" ? { url: location.href } : {}),
      ...(meta?.tab ? { tab: meta.tab } : {}),
      ...(meta?.source ? { source: meta.source } : {}),
      hash: canonicalToolsHash(descriptors),
      tools: descriptors,
    });
  };

  const handleCall = async (msg: {
    callId: string;
    ns: string;
    name: string;
    args?: unknown;
  }): Promise<void> => {
    const { callId, ns, name, args } = msg;
    const tool = registry.get(ns)?.find((t) => t.name === name);
    if (!tool) {
      send({ v: 1, type: "result", callId, ok: false, error: `no tool "${name}" in "${ns}"` });
      return;
    }
    try {
      const value = await tool.run(args);
      let payload: unknown;
      try {
        payload = toJsonSafe(value);
      } catch {
        send({
          v: 1,
          type: "result",
          callId,
          ok: false,
          error: "tool result is not JSON-serializable",
        });
        return;
      }
      send({ v: 1, type: "result", callId, ok: true, value: payload });
    } catch (err) {
      send({
        v: 1,
        type: "result",
        callId,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
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
    if (msg.type === "call" && typeof msg.callId === "string" && typeof msg.ns === "string") {
      void handleCall(
        msg as unknown as { callId: string; ns: string; name: string; args?: unknown },
      );
    }
    // "registered" acks are informational; the client doesn't need them.
  };

  const probe = opts.probe ?? defaultProbe(port);

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
    let ws: ToolsSocketLike;
    try {
      ws = factory(url);
    } catch {
      scheduleAttempt(PROBE_ATTEMPTS);
      return;
    }
    socket = ws;
    ws.addEventListener("open", (() => {
      connected = true;
      // Re-declare everything on every (re)connect; the server dedupes by hash.
      for (const [ns, tools] of registry) {
        sendRegister(ns, tools);
      }
    }) as (event: never) => void);
    ws.addEventListener("message", handleMessage as (event: never) => void);
    ws.addEventListener("close", (() => {
      connected = false;
      socket = undefined;
      // A drop starts a fresh probe episode — never a blind re-dial.
      scheduleAttempt(PROBE_ATTEMPTS);
    }) as (event: never) => void);
    // An error is followed by close; reconnection happens there.
    ws.addEventListener("error", (() => {}) as (event: never) => void);
  };

  const handleProbe = (status: ToolsProbeResult, attemptsLeft: number): void => {
    if (disposed) {
      return;
    }
    if (status === "tools") {
      dial();
    } else if (status === "no-tools") {
      // This channel build will never grow the endpoint mid-life — go dormant
      // for this page load. Registrations still accumulate locally, so a page
      // served against an older channel behaves exactly as before the bridge.
      console.debug("aiui: channel has no /tools endpoint (older build) — page tools stay local");
    } else if (attemptsLeft > 1) {
      scheduleAttempt(attemptsLeft - 1);
    }
  };

  const attempt = (attemptsLeft: number): void => {
    if (disposed) {
      return;
    }
    let result: ToolsProbeResult | Promise<ToolsProbeResult>;
    try {
      result = probe();
    } catch {
      handleProbe("unreachable", attemptsLeft);
      return;
    }
    if (typeof result === "string") {
      // Synchronous probes (tests) keep the whole flow synchronous.
      handleProbe(result, attemptsLeft);
    } else {
      result.then(
        (status) => handleProbe(status, attemptsLeft),
        () => handleProbe("unreachable", attemptsLeft),
      );
    }
  };

  const api: ToolsBridgeApi & { [BRIDGE_MARK]?: () => void } = {
    register(ns: string, tools: BridgeTool[]): void {
      registry.set(ns, tools.slice());
      sendRegister(ns, tools);
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
    if (inst.tools === api) {
      inst.tools = undefined;
    }
  };
  api[BRIDGE_MARK] = dispose;

  inst.tools = api;
  attempt(PROBE_ATTEMPTS);

  // Let late-loading page modules know the API is ready to forward into.
  if (typeof CustomEvent !== "undefined") {
    document.dispatchEvent(new CustomEvent(READY_EVENT));
  }

  return dispose;
}
