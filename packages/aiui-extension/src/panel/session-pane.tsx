/**
 * The Session pane: pick a channel, bind this window to it, see who else is
 * on the session. The binding is the per-window session model's anchor —
 * everything later (turns, capture, tools) rides the connection made here.
 */
import { Pane } from "@habemus-papadum/aiui-webext";
import { createSignal, For, Show } from "solid-js";
import { type BusState, connectSessionBus, INITIAL_BUS_STATE, type SessionBusClient } from "./bus";
import {
  type ChannelEntry,
  channelLabel,
  discoverChannels,
  loadRecentPorts,
  nativeListChannels,
  probeHealth,
  saveRecentPort,
} from "./channel";

/** Per-window auto-reconnect memory (storage.session dies with the browser). */
const lastPortKey = (windowId: number | undefined): string => `aiui.lastPort.win${windowId ?? 0}`;

export interface SessionHandle {
  /** The live bus state, for the header chip. */
  bus: () => BusState;
  /** The bound port, when connected. */
  port: () => number | undefined;
}

export function SessionPane(props: { windowId: () => number | undefined }): {
  view: () => ReturnType<typeof Pane>;
  handle: SessionHandle;
} {
  const [channels, setChannels] = createSignal<ChannelEntry[]>([]);
  const [portText, setPortText] = createSignal("");
  const [status, setStatus] = createSignal("scanning recent ports…");
  const [bus, setBus] = createSignal<BusState>({ ...INITIAL_BUS_STATE, phase: "closed" });
  const [boundPort, setBoundPort] = createSignal<number | undefined>();
  let client: SessionBusClient | undefined;

  // The window id resolved HERE, not via the panel's signal: the signal
  // arrives async, and racing it made startup read the remembered port under
  // the wrong key (`win0`) while connect() saved under `win<id>` — the
  // debt-listed "rebind flake after panel reopen", which was deterministic
  // key skew, not a flake. (Reopens within one extension load restore; an
  // extension reload still forgets — storage.session dies with it.)
  const windowIdReady: Promise<number | undefined> = chrome.windows
    .getCurrent()
    .then((w) => w.id)
    .catch(() => undefined);

  const disconnect = (): void => {
    client?.close();
    client = undefined;
    setBoundPort(undefined);
    setBus({ ...INITIAL_BUS_STATE, phase: "closed" });
    setStatus("disconnected");
  };

  const connect = async (port: number): Promise<void> => {
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
    const label = `browser window ${props.windowId() ?? "?"}`;
    client = connectSessionBus({ port, label, role: "window" });
    client.onChange(setBus);
    setBoundPort(port);
    setStatus(
      health.debug === true
        ? `bound to :${port} (debug server — no Claude session)`
        : `bound to :${port}`,
    );
    void saveRecentPort(port);
    void windowIdReady.then((win) => chrome.storage.session.set({ [lastPortKey(win)]: port }));
  };

  /**
   * Discovery, two tiers: the native host (registry on disk, zero config)
   * first; port probing (typed + recents + known) as the fallback when the
   * host isn't installed. Returns a status suffix naming the source.
   */
  const discover = async (extraSeeds: number[] = []): Promise<void> => {
    const native = await nativeListChannels();
    if (native !== undefined) {
      setChannels(native);
      setStatus(
        native.length === 0
          ? "native host: no channels running"
          : `${native.length} channel(s) via native host`,
      );
      return;
    }
    const seeds = [...extraSeeds, ...(await loadRecentPorts()), ...channels().map((c) => c.port)];
    const found = await discoverChannels(seeds);
    setChannels(found);
    setStatus(
      found.length === 0
        ? "native host not installed; no live ports remembered — type a port, then connect"
        : `${found.length} channel(s) found (port scan — native host not installed)`,
    );
  };

  // Startup: discover, then auto-reconnect the port this window used before
  // the panel was last closed (keyed by the resolved window id — see above).
  // With nothing remembered and exactly ONE channel discovered, bind it
  // (decided 2026-07-11): the cold ⌘B flow shouldn't stall on a click that
  // has only one possible answer. Multiple channels still wait for the
  // user's pick — the per-window choice survives where it matters.
  void (async () => {
    await discover();
    const key = lastPortKey(await windowIdReady);
    const remembered = (await chrome.storage.session.get(key))[key];
    if (typeof remembered === "number") {
      void connect(remembered);
      return;
    }
    const found = channels();
    if (found.length === 1) {
      await connect(found[0].port);
      if (boundPort() === found[0].port) {
        setStatus(`auto-bound to :${found[0].port} (the only channel)`);
      }
    }
  })();

  /** The typed port, when valid — rescan and connect both honor it. */
  const typedPort = (): number | undefined => {
    const port = Number(portText());
    return Number.isInteger(port) && port > 0 ? port : undefined;
  };

  const rescan = async (): Promise<void> => {
    setStatus("rescanning…");
    const typed = typedPort();
    await discover(typed !== undefined ? [typed] : []);
  };

  const connectTyped = (): void => {
    const port = typedPort();
    if (port !== undefined) {
      void connect(port);
    } else {
      setStatus("enter a numeric port first");
    }
  };

  const view = () => (
    <Pane title="Session" hint={boundPort() !== undefined ? `:${boundPort()}` : "unbound"}>
      <div class="row">
        <For each={channels()}>
          {(entry) => (
            <button
              type="button"
              class="chan"
              disabled={boundPort() === entry.port}
              onClick={() => void connect(entry.port)}
            >
              {channelLabel(entry)}
            </button>
          )}
        </For>
        <button type="button" class="ghost" onClick={() => void rescan()}>
          rescan
        </button>
      </div>
      <div class="row">
        <input
          placeholder="port…"
          size={8}
          value={portText()}
          onInput={(e) => setPortText(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              connectTyped();
            }
          }}
        />
        <button type="button" class="chan" onClick={connectTyped}>
          connect
        </button>
        <Show when={boundPort() !== undefined}>
          <button type="button" class="ghost" onClick={disconnect}>
            disconnect
          </button>
        </Show>
      </div>
      <div class="kv">{status()}</div>
      <Show when={bus().phase === "connected"}>
        <div class="kv">
          peers ({bus().peers.filter((p) => p.clientId !== bus().clientId).length}):
        </div>
        <For each={bus().peers.filter((p) => p.clientId !== bus().clientId)}>
          {(peer) => (
            <div class="peer">
              <span class="role">{peer.role ?? "view"}</span>{" "}
              {peer.label ?? peer.url ?? peer.clientId}
            </div>
          )}
        </For>
      </Show>
    </Pane>
  );

  return { view, handle: { bus, port: boundPort } };
}
