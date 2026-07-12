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
import { createSignal } from "solid-js";
import { type BusState, connectSessionBus, INITIAL_BUS_STATE, type SessionBusClient } from "./bus";
import { type ChannelEntry, channelLabel, probeHealth, saveRecentPort } from "./channel";
import { discoverOnce } from "./model/graph";

/** Per-window auto-reconnect memory (storage.session dies with the browser). */
const lastPortKey = (windowId: number | undefined): string => `aiui.lastPort.win${windowId ?? 0}`;

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
  const [boundPort, setBoundPort] = createSignal<number | undefined>();
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
    setBoundPort(undefined);
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
    setBoundPort(port);
    setLabel(portLabel);
    setStatus(
      health.debug === true
        ? `bound to :${port} (debug server — no Claude session)`
        : `bound to :${port}`,
    );
    void saveRecentPort(port);
    void chrome.storage.session.set({ [lastPortKey(win)]: port });
  };

  const connect = (entry: ChannelEntry): Promise<void> =>
    connectPort(entry.port, channelLabel(entry));

  // Boot: one discovery pass (shared with the cell via discoverOnce), then
  // auto-reconnect the remembered port; with nothing remembered and exactly
  // ONE channel discovered, bind it (decided 2026-07-11 — the cold ⌘B flow
  // shouldn't stall on a click with one possible answer).
  void (async () => {
    const key = lastPortKey(await windowIdReady);
    const remembered = (await chrome.storage.session.get(key))[key];
    const found = (await discoverOnce()).list;
    if (typeof remembered === "number") {
      const entry = found.find((c) => c.port === remembered);
      void connectPort(remembered, entry !== undefined ? channelLabel(entry) : `:${remembered}`);
      return;
    }
    if (found.length === 1) {
      await connect(found[0]);
      if (boundPort() === found[0].port) {
        setStatus(`auto-bound to :${found[0].port} (the only channel)`);
      }
    }
  })();

  return { bus, port: boundPort, label, status, connect, disconnect };
}
