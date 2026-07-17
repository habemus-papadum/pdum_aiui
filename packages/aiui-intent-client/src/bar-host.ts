/**
 * bar-host.ts — the intent client as a remote-bar HOST (Phase 3).
 *
 * The panel's command bar is the one mode engine's projection; this registers a
 * SUBSET of it over the `/bar` channel so a bar-only remote — the iPad pencil
 * client, which already embeds `RemoteBar` on `/bar/client` — can see and tap
 * the caps the owner marked `remote: true` (hands-free, video, pencil). One machine,
 * one truth: the remote holds no engine, it renders what we publish and sends taps
 * back, exactly as the desktop panel is itself a projection.
 *
 * ## The source is FLAT, on purpose
 *
 * `IntentClient.bar()` returns the DEPTH-FIRST tree (`BarTreeNode[]`) the command
 * bar draws — not a shape `bindRemoteBar` flattens (it knows `barModel` rows and
 * bare cap lists, not tree nodes). So the source here re-projects the SAME spec
 * with `barModel` (breadth-first rows), which the binding flattens to caps and
 * the `remote` filter narrows. The remote projection is intentionally flat: a
 * bar-only remote has no room for the desktop's bracketed grouping.
 *
 * ## Security (the known gap — deferred, not fixed; see the plan's Security note)
 *
 * The `filter` is DISPLAY-only: it decides which caps the remote SEES, but
 * `BarHost.receive` dispatches whatever command a socket sends, with no check
 * that it is a currently-projected `remote` cap (remote-bar `core.ts`). Binding
 * this host makes that reachable from any `/bar` socket. The owner deferred the
 * fix (an Origin allow-list on the upgrade + host-side membership enforcement);
 * it is called out here so the exposure is deliberate, not accidental.
 */

import {
  type BarSource,
  bindRemoteBar,
  decode,
  encode,
  type WireCap,
} from "@habemus-papadum/aiui-remote-bar";
import { barModel } from "@habemus-papadum/aiui-viz/modal";
import { intentBar } from "./caps";
import type { IntentClient } from "./client";

const RECONNECT_MS = 2000;
const WS_OPEN = 1;

/** The socket surface we drive — a `WebSocket`, narrowed to what we touch. */
export interface BarSocket {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: string, handler: (event: { data?: unknown }) => void): void;
}

export interface BarHostOptions {
  client: IntentClient;
  /** The channel port — the `/bar` relay is on it; dialed LOOPBACK. */
  port: number;
  /** The session label the iPad sees in its picker. */
  label: string;
  /** Test seam: build the socket (default: a real loopback `WebSocket`). */
  socketFactory?: (url: string) => BarSocket;
}

export interface BarHostHandle {
  connect(): void;
  dispose(): void;
}

/** True for a cap in the remote subset — the D5 `filter`, host-side. Only these
 * cross to the iPad; everything else stays on the desktop bar. */
export function isRemoteCap(cap: WireCap): boolean {
  return cap.remote === true;
}

/**
 * The intent client as a `BarSource`, projected FLAT (`barModel` rows). The
 * binding flattens rows to caps and drops widgets; the `remote` flag rides each
 * cap so the host `filter` can narrow to the remote subset. Reads engine signals
 * at call time, so `bindRemoteBar`'s effect re-publishes on every commit.
 */
export function intentBarSource(client: IntentClient): BarSource {
  return {
    bar: () =>
      barModel(intentBar, {
        state: client.state(),
        ctx: client.context(),
        claims: client.claimStatuses(),
        canDispatch: client.canDispatch,
      }),
    claimStatuses: () => client.claimStatuses(),
    state: () => ({ phase: client.state().phase }),
    dispatch: (command, payload) => client.dispatch(command, payload),
  };
}

/**
 * Register the intent client's remote bar on the `/bar` relay and keep it
 * published. Dials loopback (works from both the served page and the extension
 * panel, whatever the page's own origin), registers with the channel port so the
 * relay can name the session in the iPad's picker, and reconnects on drop.
 */
export function createBarHost(opts: BarHostOptions): BarHostHandle {
  const source = intentBarSource(opts.client);
  const url = `ws://127.0.0.1:${opts.port}/bar/host`;
  const factory = opts.socketFactory ?? ((u: string) => new WebSocket(u) as unknown as BarSocket);

  let socket: BarSocket | undefined;
  let unbind: (() => void) | undefined;
  let reconnect: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const dial = (): void => {
    const ws = factory(url);
    socket = ws;

    ws.addEventListener("open", () => {
      ws.send(encode({ type: "register", label: opts.label, channelPort: opts.port }));
      // Bind AFTER open: bindRemoteBar publishes once immediately (the relay
      // caches it for join-time replay), and a publish into a CONNECTING socket
      // is silently dropped.
      const bound = bindRemoteBar(source, {
        send: (message) => {
          if (ws.readyState === WS_OPEN) {
            ws.send(encode(message));
          }
        },
        filter: isRemoteCap,
      });
      unbind = () => bound.dispose();
      ws.addEventListener("message", (event) => {
        if (typeof event.data !== "string") {
          return;
        }
        const message = decode(event.data);
        if (message) {
          bound.host.receive(message as never);
        }
      });
    });

    ws.addEventListener("close", () => {
      unbind?.();
      unbind = undefined;
      if (!stopped) {
        reconnect = setTimeout(dial, RECONNECT_MS);
      }
    });
    ws.addEventListener("error", () => ws.close());
  };

  return {
    connect: () => {
      if (socket === undefined) {
        dial();
      }
    },
    dispose: () => {
      stopped = true;
      clearTimeout(reconnect);
      unbind?.();
      socket?.close();
    },
  };
}
