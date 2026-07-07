/**
 * The session bus: the channel's relay for **multiple browser views of one
 * session** — the app tab, the code reader, a future git viewer or iPad surface —
 * building up a single prompt together.
 *
 * A channel process *is* a session (one per Claude Code session, one port), so
 * every tab that dials this process is part of the same session. Each opens a
 * websocket to `/session` and the hub relays small JSON messages between them:
 *
 *  - **shared state** (`set` / snapshot): last-writer-wins named slots the hub
 *    caches — `armed` (is the turn armed?) and `preview` (the prompt so far) —
 *    so a tab that joins late is handed the current state and immediately agrees
 *    with the others. A `set` is cached and broadcast to every *other* tab.
 *  - **transient publishes** (`publish`): fire-and-forget broadcasts the hub does
 *    NOT cache — a code selection contributed to the turn, a nudge — delivered to
 *    every other tab and gone. A publish can also originate *outside* the bus:
 *    an external same-host tool (the VS Code extension) posts to the web
 *    backend's `POST /session/publish`, which calls
 *    {@link SessionHub.publishFromServer} to hand the message to a chosen view
 *    (`from: "server"`).
 *  - **peers**: who else is here (role/label/url), pushed on join and leave so a
 *    view can show "code reader connected".
 *
 * Deliberately dumb: the hub relays and caches opaque JSON; it does not interpret
 * `armed` or a contribution. The *meaning* lives in the tabs (the overlay's turn
 * host, the reader's session panel). That keeps this one relay reusable for any
 * new view — the general pattern the design calls for.
 *
 * Transport-agnostic like {@link PageToolDirectory}: a connection is an id + a
 * `send` function, so it is unit-testable without a real socket (see
 * session-hub.test.ts). web.ts wires it to the `/session` websocket.
 *
 * Nothing here may write to stdout: in the `mcp` command that stream carries the
 * MCP stdio protocol. Diagnostics go through {@link SessionHubOptions.log}.
 */
import { randomUUID } from "node:crypto";
import type { TabInfo } from "./frame";

/** What a connected view tells the hub about itself (rides the `hello`). */
export interface SessionPeerInfo {
  /** Server-assigned connection id. */
  clientId: string;
  /** What kind of view this is: `app`, `code`, `git`, `ipad`, … (free-form). */
  role?: string;
  /** A short human label for the peer list (e.g. the page title). */
  label?: string;
  /** The view's live `location.href`. */
  url?: string;
  /** The browser tab the view lives in (correlation hints; see {@link TabInfo}). */
  tab?: TabInfo;
}

/** One cached shared-state slot. */
interface Slot {
  value: unknown;
  from: string;
  at: string;
}

/** A message a client sends up the `/session` socket. */
export type SessionClientMessage =
  | { v?: 1; type: "hello"; role?: string; label?: string; url?: string; tab?: TabInfo }
  | { v?: 1; type: "set"; slot: string; value: unknown }
  | { v?: 1; type: "publish"; topic: string; payload?: unknown };

/** A message the hub pushes down a `/session` socket. */
export type SessionServerMessage =
  | {
      v: 1;
      type: "snapshot";
      clientId: string;
      state: Record<string, unknown>;
      peers: SessionPeerInfo[];
    }
  | { v: 1; type: "set"; slot: string; value: unknown; from: string }
  | { v: 1; type: "publish"; topic: string; payload?: unknown; from: string }
  | { v: 1; type: "peers"; peers: SessionPeerInfo[] };

/** How the hub pushes a message to one connection. */
export type SessionSend = (message: SessionServerMessage) => void;

/** A cheap summary for `/health` / `/debug`. */
export interface SessionSummary {
  /** Open session views. */
  clients: number;
  /** Cached shared-state slots. */
  slots: number;
  /** The distinct roles currently connected (e.g. `["app","code"]`). */
  roles: string[];
}

export interface SessionHubOptions {
  /** Where the change-log line goes; defaults to stderr (stdout carries MCP). */
  log?: (line: string) => void;
  /** Clock for slot timestamps — inject for deterministic tests. */
  now?: () => Date;
  /** Id generator — inject for deterministic tests. */
  newId?: () => string;
}

interface Connection {
  clientId: string;
  send: SessionSend;
  info: SessionPeerInfo;
  /** Whether this connection has sent its `hello` yet (in the peer list). */
  greeted: boolean;
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;

/**
 * The channel's live session bus: the connected views and the shared state they
 * agree on. One instance per channel process; shared by the `/session` websocket
 * (which feeds it) and `/health` (which summarizes it).
 */
export class SessionHub {
  private readonly connections = new Map<string, Connection>();
  private readonly state = new Map<string, Slot>();
  private readonly log: (line: string) => void;
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(options: SessionHubOptions = {}) {
    this.log = options.log ?? ((line) => process.stderr.write(`${line}\n`));
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? randomUUID;
  }

  /** Register a freshly connected session socket; returns its server-assigned id.
   * The peer is not announced until its `hello` arrives (so the peer list carries
   * role/label). */
  addConnection(send: SessionSend): string {
    const clientId = this.newId();
    this.connections.set(clientId, {
      clientId,
      send,
      info: { clientId },
      greeted: false,
    });
    return clientId;
  }

  /** Drop a connection and tell everyone else the peer list shrank. */
  removeConnection(clientId: string): void {
    const conn = this.connections.get(clientId);
    if (!conn) {
      return;
    }
    this.connections.delete(clientId);
    if (conn.greeted) {
      this.log(`session: ${conn.info.role ?? "view"} left (${this.connections.size} connected)`);
      this.broadcastPeers();
    }
  }

  /** Dispatch one parsed client message. Validates loosely — a malformed message
   * is ignored rather than fatal (cooperative same-host client). */
  handleClientMessage(clientId: string, raw: unknown): void {
    const msg = asRecord(raw);
    if (!msg) {
      return;
    }
    if (msg.type === "hello") {
      this.hello(clientId, msg);
    } else if (msg.type === "set" && typeof msg.slot === "string") {
      this.setSlot(clientId, msg.slot, msg.value);
    } else if (msg.type === "publish" && typeof msg.topic === "string") {
      this.publish(clientId, msg.topic, msg.payload);
    }
  }

  private hello(clientId: string, msg: Record<string, unknown>): void {
    const conn = this.connections.get(clientId);
    if (!conn) {
      return;
    }
    conn.info = {
      clientId,
      ...(typeof msg.role === "string" ? { role: msg.role } : {}),
      ...(typeof msg.label === "string" ? { label: msg.label } : {}),
      ...(typeof msg.url === "string" ? { url: msg.url } : {}),
      ...(asRecord(msg.tab) ? { tab: asRecord(msg.tab) as TabInfo } : {}),
    };
    const firstGreeting = !conn.greeted;
    conn.greeted = true;
    // Hand the newcomer the current shared state + peer list so it agrees with
    // everyone immediately.
    conn.send({
      v: 1,
      type: "snapshot",
      clientId,
      state: this.stateObject(),
      peers: this.peerList(),
    });
    if (firstGreeting) {
      this.log(`session: ${conn.info.role ?? "view"} joined (${this.connections.size} connected)`);
    }
    // Tell everyone else the peer list grew (or a peer relabeled).
    this.broadcastPeers(clientId);
  }

  private setSlot(clientId: string, slot: string, value: unknown): void {
    this.state.set(slot, { value, from: clientId, at: this.now().toISOString() });
    this.broadcast({ v: 1, type: "set", slot, value, from: clientId }, clientId);
  }

  private publish(clientId: string, topic: string, payload: unknown): void {
    this.broadcast({ v: 1, type: "publish", topic, payload, from: clientId }, clientId);
  }

  /** The current value of one shared-state slot, if set (server-side reads). */
  get(slot: string): unknown {
    return this.state.get(slot)?.value;
  }

  /** The greeted peers, for external listing (`GET /session/peers`). */
  peers(): SessionPeerInfo[] {
    return this.peerList();
  }

  /**
   * A server-originated publish: an external same-host tool (the VS Code
   * extension, a CLI) contributing to the session through the web backend
   * instead of holding a `/session` socket of its own. Targets one view by
   * `clientId`, every greeted view with `role`, or — no target — every greeted
   * view. Returns the peers actually sent to, so the HTTP caller can be told
   * whether anything was reachable (`from` is `"server"`, which can never
   * collide with a connection id — those are UUIDs).
   */
  publishFromServer(
    topic: string,
    payload: unknown,
    target: { clientId?: string; role?: string } = {},
  ): SessionPeerInfo[] {
    const matches = [...this.connections.values()].filter(
      (c) =>
        c.greeted &&
        (target.clientId === undefined || c.clientId === target.clientId) &&
        (target.role === undefined || c.info.role === target.role),
    );
    const message: SessionServerMessage = { v: 1, type: "publish", topic, payload, from: "server" };
    for (const conn of matches) {
      try {
        conn.send(message);
      } catch {
        // A send racing a close is harmless; the close path cleans up.
      }
    }
    if (matches.length > 0) {
      this.log(`session: server published "${topic}" to ${matches.length} view(s)`);
    }
    return matches.map((c) => c.info);
  }

  /** Send a message to every connection except `except`. */
  private broadcast(message: SessionServerMessage, except?: string): void {
    for (const conn of this.connections.values()) {
      if (conn.clientId === except) {
        continue;
      }
      try {
        conn.send(message);
      } catch {
        // A send racing a close is harmless; the close path cleans up.
      }
    }
  }

  private broadcastPeers(except?: string): void {
    const peers = this.peerList();
    this.broadcast({ v: 1, type: "peers", peers }, except);
  }

  private peerList(): SessionPeerInfo[] {
    return [...this.connections.values()].filter((c) => c.greeted).map((c) => c.info);
  }

  private stateObject(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [slot, entry] of this.state) {
      out[slot] = entry.value;
    }
    return out;
  }

  /** Cheap counts for a `/health` or `/debug` summary. */
  summary(): SessionSummary {
    const roles = new Set<string>();
    for (const conn of this.connections.values()) {
      if (conn.greeted && conn.info.role) {
        roles.add(conn.info.role);
      }
    }
    return { clients: this.connections.size, slots: this.state.size, roles: [...roles] };
  }
}
