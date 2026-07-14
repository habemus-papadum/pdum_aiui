/**
 * @habemus-papadum/aiui-remote-bar — the command bar as its own channel
 * (aiui-pencil plan, decision D5). The mode engine of a host page, projected over
 * its own websocket, mounted as a channel sidecar at its own URL, with a Solid
 * client that renders the projected bar and dispatches taps back.
 *
 * This barrel is the **browser/isomorphic** surface — the wire, the socket-free
 * cores, the host binding, and the client component. The node relay is a separate
 * import so this entry never drags `ws`/`express` into a browser bundle:
 *
 *   import { createBarBackend } from "@habemus-papadum/aiui-remote-bar/server";
 *   import { barSidecar }       from "@habemus-papadum/aiui-remote-bar/sidecar";
 *
 * Layers:
 *  - protocol.ts — the pure wire (`bar` down / `command` up), the WireCap↔CapView
 *    drift guard, framing.
 *  - core.ts     — the two endpoint cores, socket-free (a `send` in, a `receive` out).
 *  - solid.ts    — the host binding: a `solidModeEngine`-shaped source → the wire.
 *  - ui/         — the remote's reactive client (behind a transport seam) + the
 *    `RemoteBar` Solid component.
 */

export { BarClient, type BarClientOptions, BarHost, type BarHostOptions } from "./core";
export {
  type BarState,
  type ClientToRelay,
  decode,
  encode,
  type HostToRelay,
  isRemoteCommand,
  PROTOCOL_VERSION,
  type RelayToClient,
  type RelayToHost,
  type RemoteCommand,
  type SessionInfo,
  type WireCap,
  type WireMessage,
} from "./protocol";
export {
  type BarSource,
  type BindRemoteBarOptions,
  type BoundRemoteBar,
  bindRemoteBar,
} from "./solid";
export {
  type BarTransport,
  type BarTransportFactory,
  type BarTransportHandlers,
  type ConnectionStatus,
  createRemoteBarClient,
  defaultBarUrl,
  type RemoteBarClient,
  type RemoteBarClientOptions,
  websocketTransport,
} from "./ui/client";
export { REMOTE_BAR_STYLES, RemoteBar, type RemoteBarProps } from "./ui/RemoteBar";
