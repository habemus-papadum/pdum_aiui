/**
 * core.ts — the two endpoint cores: the wire's logic, with no socket in it.
 *
 * Neither core touches a websocket: each takes a `send` callback and exposes a
 * `receive` method, so the whole protocol drives in node, in a test, with no
 * network and no DOM. The socket is a few lines of adapter in the app (the host
 * page's `ws.onmessage → host.receive`; the client component's transport seam).
 * This is the same shape the pencil's `remote.ts` cores use, minus everything
 * ink/video/signaling.
 */

import type {
  ClientToRelay,
  HostToRelay,
  RelayToClient,
  RelayToHost,
  SessionInfo,
  WireCap,
} from "./protocol";

// ── the host's endpoint (desktop / the page that owns the mode engine) ───────

export interface BarHostOptions {
  /** Put a message on the wire. */
  send: (message: HostToRelay) => void;
  /**
   * App-level filter over the projected rows — D5's "the remote may see only a
   * subset". Applied inside {@link BarHost.publishBar}; a cap the predicate
   * rejects never reaches the wire, so it can be neither seen nor tapped. Absent
   * = the whole bar is projected.
   */
  filter?: (cap: WireCap) => boolean;
  /**
   * A command arrived from a remote (a bar tap) — dispatch it into the mode
   * engine. The host owns the engine; this is the ONLY inbound verb.
   */
  onCommand?: (command: string, payload?: unknown) => void;
  /** A remote joined this host's room (relay lifecycle) — e.g. to re-publish. */
  onClientJoined?: (client: string) => void;
  /** A remote left this host's room. */
  onClientLeft?: (client: string) => void;
}

/**
 * The host's endpoint: projects the mode engine over the wire and turns remote
 * taps back into engine dispatches.
 *
 * It holds no engine and no reactive graph — the Solid binding (`solid.ts`)
 * feeds it `publishBar` on every commit and wires `onCommand` to the engine's
 * `dispatch`. Kept a plain class so it is drivable with a fake `send` in a node
 * test, exactly like the pencil's `RemoteHost`.
 */
export class BarHost {
  constructor(private readonly opts: BarHostOptions) {}

  /**
   * Project the current bar. `rows` is `barModel()`'s output (a `CapView[]` is a
   * `WireCap[]`); the optional {@link BarHostOptions.filter} is applied here so
   * the subset decision lives in one place. `claims` is the per-name status
   * phase; `phase` is the engine's phase for the pill.
   */
  publishBar(rows: readonly WireCap[], claims: Record<string, string>, phase?: string): void {
    const filter = this.opts.filter;
    const projected = filter ? rows.filter((cap) => filter(cap)) : rows;
    this.opts.send({
      type: "bar",
      rows: [...projected],
      claims,
      ...(phase !== undefined ? { phase } : {}),
    });
  }

  receive(message: RelayToHost): void {
    switch (message.type) {
      case "command":
        this.opts.onCommand?.(message.command, message.payload);
        break;
      case "clientJoined":
        this.opts.onClientJoined?.(message.client);
        break;
      case "clientLeft":
        this.opts.onClientLeft?.(message.client);
        break;
      default:
        // "registered" — relay lifecycle the host binding does not need.
        break;
    }
  }
}

// ── the remote's endpoint (the bar-only client / the pencil iPad app) ────────

export interface BarClientOptions {
  /** Put a message on the wire. */
  send: (message: ClientToRelay) => void;
  /** The relay's list of connectable hosts (broadcast on connect + on change). */
  onSessions?: (sessions: SessionInfo[]) => void;
  /** A join was accepted — the remote is now viewing this host's bar. */
  onJoined?: (host: string, label: string) => void;
  /** A join was refused (e.g. the host is gone) — show it, don't retry blindly. */
  onJoinRejected?: (reason: string) => void;
  /** The host's projected bar — render it. */
  onBar?: (rows: WireCap[], claims: Record<string, string>, phase?: string) => void;
  /** The host disconnected while joined — the bar is stale; fall back to the list. */
  onHostGone?: () => void;
}

/**
 * The remote's endpoint: joins a host, renders its projected bar, and sends taps
 * back. It holds no mode engine — the host's is the only one, and this is a view
 * of it (the panel is a view too). A tap is a `command`, the identical verb a key
 * or the agent would dispatch.
 */
export class BarClient {
  constructor(private readonly opts: BarClientOptions) {}

  /** Join a host's room by its relay-assigned id. */
  join(host: string): void {
    this.opts.send({ type: "join", host });
  }

  /** Leave the current room (stay connected to the relay for the session list). */
  leave(): void {
    this.opts.send({ type: "leave" });
  }

  /** Tap a bar cap — the same command a key, or the agent, would dispatch. */
  dispatch(command: string, payload?: unknown): void {
    this.opts.send({ type: "command", command, ...(payload !== undefined ? { payload } : {}) });
  }

  receive(message: RelayToClient): void {
    switch (message.type) {
      case "sessions":
        this.opts.onSessions?.(message.sessions);
        break;
      case "joined":
        this.opts.onJoined?.(message.host, message.label);
        break;
      case "joinRejected":
        this.opts.onJoinRejected?.(message.reason);
        break;
      case "bar":
        this.opts.onBar?.(message.rows, message.claims, message.phase);
        break;
      case "hostGone":
        this.opts.onHostGone?.();
        break;
      default:
        break;
    }
  }
}
