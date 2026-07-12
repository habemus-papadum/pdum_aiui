/**
 * The per-window session BINDING, headless (the Session pane retired into the
 * header's connection chip, 2026-07-12). Discovery is the graph's cell; this
 * module owns the connection: bind/unbind, the remembered-port + auto-bind
 * boot, and the bus client — an imperative island (a live connection is not
 * a cell), read through plain signals.
 *
 * Resilience (§13.6 adjacent, decided 2026-07-12): the bus client re-dials on
 * its own timer, so a channel restart (the hot-reload case) shows as
 * "connecting" on the chip and self-heals when the channel returns. Losing
 * the socket NEVER touches the phase machine — armed and the open turn
 * survive outages; the wire is stateless enough that resuming just works.
 */
import { liveSignal } from "@habemus-papadum/aiui-viz";
import { createSignal } from "solid-js";
import { type BusState, connectSessionBus, INITIAL_BUS_STATE, type SessionBusClient } from "./bus";
import { type ChannelEntry, channelLabel, probeHealth, saveRecentPort } from "./channel";
import { discoverOnce } from "./model/graph";

/**
 * Auto-reconnect memory. TWO keys, on purpose (fixed live 2026-07-12 — the
 * panel stopped auto-binding):
 *
 *  - per-window, in `storage.session`: which channel THIS window was on. Right
 *    scope, but session storage dies with the browser AND with every extension
 *    reload (which, in development, is constantly).
 *  - a global "last bound port", in `storage.local`: survives both. It is the
 *    fallback when the window has no memory of its own — a new window, a
 *    restarted browser, a reloaded extension.
 *
 * Either way the port is PROBED before use, so a remembered channel that has
 * since died just falls through to discovery.
 */
const lastPortKey = (windowId: number | undefined): string => `aiui.lastPort.win${windowId ?? 0}`;
const LAST_PORT_GLOBAL = "aiui.lastPort";

export interface SessionHandle {
  /** The live bus state, for the chip (connected/connecting) and peers. */
  bus: () => BusState;
  /** The bound port, when connected. */
  port: () => number | undefined;
  /** "name :port" for the bound channel (discovery label; ":port" fallback). */
  label: () => string;
  /** The last binding-flow message (probe failures, auto-bind notes). */
  status: () => string;
  connect: (entry: ChannelEntry) => Promise<void>;
  disconnect: () => void;
}

export function createSession(): SessionHandle {
  const [bus, setBus] = createSignal<BusState>({ ...INITIAL_BUS_STATE, phase: "closed" });
  // liveSignal, not createSignal: the boot sequence writes this and BRANCHES
  // on it in the same flow (the reconnect loop) — a batched signal read there
  // is stale (the library primitive exists because this class of bug bit the
  // panel five times; see aiui-viz/live-signal).
  const boundPort = liveSignal<number | undefined>(undefined);
  const [label, setLabel] = createSignal("");
  const [status, setStatus] = createSignal("");
  let client: SessionBusClient | undefined;

  // The window id resolved HERE, not via a panel signal: racing the async
  // signal once made startup read the remembered port under the wrong key
  // (`win0`) while connect() saved under `win<id>` — deterministic key skew,
  // not a flake. (Reopens within one extension load restore; an extension
  // reload still forgets — storage.session dies with it.)
  const windowIdReady: Promise<number | undefined> = chrome.windows
    .getCurrent()
    .then((w) => w.id)
    .catch(() => undefined);

  const disconnect = (): void => {
    client?.close();
    client = undefined;
    boundPort.set(undefined);
    setLabel("");
    setBus({ ...INITIAL_BUS_STATE, phase: "closed" });
    setStatus("disconnected");
  };

  const connectPort = async (port: number, portLabel: string): Promise<void> => {
    disconnect();
    setStatus(`probing :${port}…`);
    const health = await probeHealth(port);
    if (health === undefined) {
      setStatus(`no channel answered on :${port}`);
      return;
    }
    if (health.session === undefined) {
      setStatus(`:${port} is an older channel without the session bus`);
      return;
    }
    const win = await windowIdReady;
    client = connectSessionBus({ port, label: `browser window ${win ?? "?"}`, role: "window" });
    client.onChange(setBus);
    boundPort.set(port);
    setLabel(portLabel);
    setStatus(
      health.debug === true
        ? `bound to :${port} (debug server — no Claude session)`
        : `bound to :${port}`,
    );
    void saveRecentPort(port);
    void chrome.storage.session.set({ [lastPortKey(win)]: port });
    // The reload-proof memory (storage.session dies with every extension
    // reload — which in development is constantly). This write was the fix
    // for "the panel stopped auto-connecting" (2026-07-12): without it the
    // global key never existed and boot had nothing to reconnect to.
    void chrome.storage.local.set({ [LAST_PORT_GLOBAL]: port });
  };

  const connect = (entry: ChannelEntry): Promise<void> =>
    connectPort(entry.port, channelLabel(entry));

  // Boot: reconnect the channel this window was on — or, failing that, the
  // last channel ANY window bound (the global memory: an extension reload wipes
  // session storage, and in development that happens constantly). A remembered
  // port is only used if it is STILL RUNNING (discovery answers that), so a
  // dead channel degrades to the single-channel auto-bind, then to a manual
  // pick. Discovery runs once here and is shared with the cell via discoverOnce.
  void (async () => {
    const key = lastPortKey(await windowIdReady);
    const perWindow = (await chrome.storage.session.get(key))[key];
    const global = (await chrome.storage.local.get(LAST_PORT_GLOBAL))[LAST_PORT_GLOBAL];
    const found = (await discoverOnce()).list;

    for (const remembered of [perWindow, global]) {
      if (typeof remembered !== "number") {
        continue;
      }
      const entry = found.find((c) => c.port === remembered);
      if (entry === undefined) {
        continue; // remembered, but no longer running — try the next memory
      }
      await connect(entry);
      if (boundPort.get() === entry.port) {
        setStatus(`reconnected to :${entry.port}`);
        return;
      }
    }

    if (found.length === 1) {
      await connect(found[0]);
      if (boundPort.get() === found[0].port) {
        setStatus(`auto-bound to :${found[0].port} (the only channel)`);
      }
    }
  })();

  return { bus, port: boundPort.get, label, status, connect, disconnect };
}
