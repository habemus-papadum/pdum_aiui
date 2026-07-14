/**
 * protocol.ts — the remote-bar wire.
 *
 * The command bar is not a plane of the pencil protocol; it is its **own
 * channel** (plan decision D5). This wire carries exactly two things and nothing
 * else:
 *
 *   bar      host → remote   the mode engine's projection (rows + claims + phase)
 *   command  remote → host   a tap on the bar — the same command a key would send
 *
 * No ink, no video, no WebRTC signaling. A remote client that is *just the bar*
 * (the whole point of D5) needs only this file's messages and a socket.
 *
 * ## The engine stays on the host
 *
 * The host owns the one mode engine — one machine, one truth. The remote renders
 * {@link BarState} and sends {@link RemoteCommand} back; it holds no machine of
 * its own, exactly as the desktop panel holds none (the panel is a projection
 * too). A second engine on the remote would be a second source of truth for
 * state that is definitionally singular.
 *
 * ## Session plumbing mirrors the paint stream
 *
 * The relay's room model — register / join / leave / sessions / hostGone — is the
 * shape `aiui-paint` proved, minus everything media-related. It is restated here
 * (not imported) so this package takes no dependency on paint.
 *
 * Pure and dependency-free: shared verbatim by the relay (node), the host binding
 * (browser), the client component (browser), and the tests.
 */

/** Wire protocol version. Bumped when a change is not backward compatible. */
export const PROTOCOL_VERSION = 1;

// ── the control plane: the mode engine, projected ───────────────────────────

/**
 * One button on the remote's bar — structurally the renderable subset of
 * `CapView` from `aiui-viz/modal`, restated here so the wire does not drag the
 * whole modal kit into the relay (a node process that must not import Solid or
 * the engine). It is asserted against the real `CapView` in the tests: if the
 * bar model drops or retypes a field this relies on, the compiler says so there
 * (`protocol.test.ts`, the drift guard).
 *
 * The `hint` is the display subset a bar renderer actually reads — key cap,
 * label, optional icon and tone. `CapView.hint` (a `KeyHint`) carries more
 * (iconSvg, active, tapKey), but a command bar renders none of it, so the wire
 * omits it. `reveals` (mode-scoped sub-widgets like springing sliders) is
 * likewise a pencil/overlay concern, not a bar-only remote's, so it is dropped.
 */
export interface WireCap {
  /** Discriminant against `WidgetView` in a `BarRow` (widgets never wire). */
  kind: "cap";
  /** The command a tap dispatches — the same resolver path as the key. */
  command: string;
  /** Payload for the dispatch, when the command takes one. */
  payload?: unknown;
  /** Press-and-hold caps: the down/up command pair (PTT-style). */
  hold?: { down: string; up: string };
  /** Display row: key cap, label, optional icon + tone. */
  hint: { key: string; label: string; icon?: string; tone?: string };
  /** The cap renders highlighted (the mode/flag it toggles is engaged). */
  lit: boolean;
  /** The cap renders but refuses taps (gating: "needs a bound port"). */
  enabled: boolean;
}

/**
 * host → remote: the mode engine's projection.
 *
 * `rows` is `barModel()`'s output, unchanged (a `CapView[]` is a `WireCap[]` —
 * see {@link WireCap}). `claims` is the per-claim status *phase* by name
 * (`idle` | `pending` | `active` | `error` | `stale`) — the full `ClaimStatus`
 * object is host-side detail; the remote only paints the phase. `phase` is the
 * engine's current phase, for the status pill.
 */
export interface BarState {
  type: "bar";
  rows: WireCap[];
  claims: Record<string, string>;
  phase?: string;
}

/** remote → host: a tap on the bar. The same command a key or the agent dispatches. */
export interface RemoteCommand {
  type: "command";
  command: string;
  payload?: unknown;
}

/** True when `value` is a {@link RemoteCommand} — the relay's routing test, and the host's guard. */
export function isRemoteCommand(value: unknown): value is RemoteCommand {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "command" &&
    typeof (value as { command?: unknown }).command === "string"
  );
}

// ── session plumbing (relay-level) ──────────────────────────────────────────

/** Session metadata the relay advertises for each connectable host. */
export interface SessionInfo {
  /** Relay-assigned room id the remote joins. */
  id: string;
  /** Human label the host announced (page title, app name). */
  label: string;
  /** Project directory the host lives in, when known (for grouping). */
  project?: string;
  /** The aiui channel tag this host belongs to, when it declared one. */
  channelTag?: string;
  /** Whether a remote is already viewing this host. */
  busy: boolean;
  /** ISO-8601 time the host connected. */
  connectedAt: string;
}

/** remote client → relay. */
export type ClientToRelay = { type: "join"; host: string } | { type: "leave" } | RemoteCommand;

/** relay → remote client. */
export type RelayToClient =
  | { type: "sessions"; sessions: SessionInfo[] }
  | { type: "joined"; host: string; label: string }
  | { type: "joinRejected"; reason: string }
  | { type: "hostGone" }
  | BarState;

/** browser host → relay. */
export type HostToRelay =
  | {
      type: "register";
      label: string;
      project?: string;
      channelTag?: string;
      /**
       * The aiui channel web-backend port the host's page was launched with
       * (`window.__AIUI__.port`). The relay — same machine — resolves it against
       * the on-disk server registry to fill in the project dir and channel tag,
       * so the remote's session list shows which agent session each host belongs
       * to without the browser needing registry access.
       */
      channelPort?: number;
    }
  | BarState;

/** relay → browser host. */
export type RelayToHost =
  | { type: "registered"; id: string }
  | { type: "clientJoined"; client: string }
  | { type: "clientLeft"; client: string }
  | RemoteCommand;

/** Any control message that can cross the wire. */
export type WireMessage = ClientToRelay | RelayToClient | HostToRelay | RelayToHost;

// ── framing ─────────────────────────────────────────────────────────────────

/** Serialize a control message to a JSON text frame. */
export function encode(message: WireMessage): string {
  return JSON.stringify(message);
}

/**
 * Parse a text frame into a control message, or `undefined` for anything that is
 * not a JSON object with a string `type`. A malformed frame is dropped, never
 * thrown: one bad message from one client must not take down a relay serving
 * others. The wire is a trusted loopback/LAN channel, so validation is
 * shallow-but-safe — it guards against crashes on garbage, not a malicious peer.
 */
export function decode(raw: string): WireMessage | undefined {
  try {
    const value: unknown = JSON.parse(raw);
    if (
      typeof value === "object" &&
      value !== null &&
      typeof (value as { type?: unknown }).type === "string"
    ) {
      return value as WireMessage;
    }
  } catch {
    // fall through
  }
  return undefined;
}
