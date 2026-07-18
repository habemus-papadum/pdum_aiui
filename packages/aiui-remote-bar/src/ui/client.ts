/**
 * ui/client.ts — the remote's reactive client: the socket-free {@link BarClient}
 * core wrapped in Solid signals, behind a **transport seam** so the component is
 * drivable in jsdom with a fake wire (exactly the injected-host discipline the
 * intent client uses). The default transport is a real `WebSocket`; a test passes
 * its own.
 *
 * There is no mode engine here and no state machine — the remote holds a *view*
 * of the host's bar (rows / claims / phase), plus the small amount of connection
 * state a UI must show (which hosts exist, whether we joined, why a join failed).
 */

import { createSignal } from "solid-js";
import { BarClient } from "../core";
import {
  type ClientToRelay,
  decode,
  encode,
  type RelayToClient,
  type SessionInfo,
  type WireCap,
} from "../protocol";

/** Where the remote is in its connection lifecycle (drives what the UI shows). */
export type ConnectionStatus =
  | "connecting"
  | "listing"
  | "joined"
  | "hostGone"
  | "rejected"
  | "closed";

/** The wire, abstracted: what the client needs from a socket. */
export interface BarTransport {
  send(message: ClientToRelay): void;
  close(): void;
}

/** Callbacks the transport drives — open, each decoded frame, close. */
export interface BarTransportHandlers {
  onOpen(): void;
  onMessage(message: RelayToClient): void;
  onClose(): void;
}

export type BarTransportFactory = (url: string, handlers: BarTransportHandlers) => BarTransport;

/**
 * Derive the relay's client URL from the page's own location — the way pencil's
 * iPad client does. Defaults to `/bar/client` on the same host, `wss:` under
 * https. A consumer served off a *different* origin than the channel (a Vite dev
 * server on another port) passes an explicit `url` instead.
 */
export function defaultBarUrl(loc: Location = window.location): string {
  const proto = loc.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${loc.host}/bar/client`;
}

/** The default transport: a real `WebSocket`, framing via the protocol codec. */
export const websocketTransport: BarTransportFactory = (url, handlers) => {
  const ws = new WebSocket(url);
  ws.addEventListener("open", () => handlers.onOpen());
  ws.addEventListener("close", () => handlers.onClose());
  ws.addEventListener("message", (event) => {
    if (typeof event.data !== "string") {
      return; // the bar channel is text-only
    }
    const message = decode(event.data);
    if (message) {
      handlers.onMessage(message as RelayToClient);
    }
  });
  return {
    send: (message) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(encode(message));
      }
    },
    close: () => ws.close(),
  };
};

export interface RemoteBarClientOptions {
  /** Relay URL. Defaults to {@link defaultBarUrl} (same origin, `/bar/client`). */
  url?: string;
  /** Transport factory. Defaults to {@link websocketTransport}; tests inject a fake. */
  transport?: BarTransportFactory;
  /**
   * Auto-join the sole host when exactly one is listed and we are idle. On by
   * default: a bar-only remote usually faces one session and shouldn't make the
   * user click through a list of one. A rejected join stops it (no retry loop).
   */
  autoJoin?: boolean;
}

/** The reactive surface the {@link RemoteBar} component reads. */
export interface RemoteBarClient {
  sessions(): SessionInfo[];
  rows(): WireCap[];
  claims(): Record<string, string>;
  phase(): string | undefined;
  status(): ConnectionStatus;
  joinedHost(): string | undefined;
  rejectedReason(): string | undefined;
  /** Join a host by its relay id. */
  join(id: string): void;
  /** Leave the current room (back to the session list). */
  leave(): void;
  /** Tap a bar cap — the same command a key would dispatch on the host. */
  dispatch(command: string, payload?: unknown): void;
  /** Close the transport and release the client. */
  dispose(): void;
}

export function createRemoteBarClient(options: RemoteBarClientOptions = {}): RemoteBarClient {
  const factory = options.transport ?? websocketTransport;
  const url = options.url ?? defaultBarUrl();
  const autoJoin = options.autoJoin ?? true;

  const [sessions, setSessions] = createSignal<SessionInfo[]>([], { ownedWrite: true });
  const [rows, setRows] = createSignal<WireCap[]>([], { ownedWrite: true });
  const [claims, setClaims] = createSignal<Record<string, string>>({}, { ownedWrite: true });
  const [phase, setPhase] = createSignal<string | undefined>(undefined, { ownedWrite: true });
  const [status, setStatus] = createSignal<ConnectionStatus>("connecting", { ownedWrite: true });
  const [joinedHost, setJoinedHost] = createSignal<string | undefined>(undefined, {
    ownedWrite: true,
  });
  const [rejectedReason, setRejectedReason] = createSignal<string | undefined>(undefined, {
    ownedWrite: true,
  });

  // Declared before `core` because `core.send` closes over it; assigned just
  // below, before any transport handler can fire (real sockets deliver async;
  // a fake must emit on demand, not during construction).
  let transport: BarTransport;
  const core = new BarClient({
    send: (message) => transport.send(message),
    onSessions: (list) => {
      setSessions(list);
      // Auto-join the sole host, once, while idle and not previously rejected.
      if (
        autoJoin &&
        list.length === 1 &&
        joinedHost() === undefined &&
        rejectedReason() === undefined
      ) {
        core.join(list[0].id);
      }
    },
    onJoined: (host) => {
      setJoinedHost(host);
      setRejectedReason(undefined);
      setStatus("joined");
    },
    onJoinRejected: (reason) => {
      setRejectedReason(reason);
      setStatus("rejected");
    },
    onBar: (barRows, barClaims, barPhase) => {
      setRows(barRows);
      setClaims(barClaims);
      setPhase(barPhase);
    },
    onHostGone: () => {
      setJoinedHost(undefined);
      setRows([]);
      setClaims({});
      setPhase(undefined);
      setStatus("hostGone");
    },
  });

  transport = factory(url, {
    onOpen: () => {
      if (status() === "connecting") {
        setStatus("listing");
      }
    },
    onMessage: (message) => core.receive(message),
    onClose: () => setStatus("closed"),
  });

  return {
    sessions,
    rows,
    claims,
    phase,
    status,
    joinedHost,
    rejectedReason,
    join: (id) => {
      setRejectedReason(undefined);
      core.join(id);
    },
    leave: () => {
      core.leave();
      setJoinedHost(undefined);
      setRows([]);
      setClaims({});
      setPhase(undefined);
      setStatus("listing");
    },
    dispatch: (command, payload) => core.dispatch(command, payload),
    dispose: () => transport.close(),
  };
}
