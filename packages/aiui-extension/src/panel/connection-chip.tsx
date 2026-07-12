/**
 * The header's connection chip — the retired Session pane, folded into one
 * dropdown (decided 2026-07-12). The trigger shows dot + "name :port"
 * (green = bus connected, amber = bound but re-dialing — a channel restart
 * self-heals without touching armed/turn, gray = unbound). Opening the
 * dropdown fires the `rescan` action (the Dropdown widget's refresh hook);
 * the body is the discovery cell's list, the binding status, peers, and
 * disconnect. Explicit-port entry was deliberately dropped (decided
 * 2026-07-12; discovery covers the flows).
 */
import { CellView, Dropdown } from "@habemus-papadum/aiui-viz";
import { For, Show } from "solid-js";
import { channelLabel } from "./channel";
import { graph, rescan } from "./model/graph";
import type { SessionHandle } from "./session";

export function ConnectionChip(props: { session: SessionHandle }) {
  const s = props.session;
  const chipClass = (): string =>
    s.bus().phase === "connected" ? "chip on" : s.port() !== undefined ? "chip connecting" : "chip";
  const others = () => s.bus().peers.filter((p) => p.clientId !== s.bus().clientId);

  return (
    <Dropdown
      class={chipClass()}
      label="channel connection"
      onOpen={() => void rescan.run()}
      trigger={
        <>
          <span class="dot" />
          {s.port() !== undefined ? s.label() : "no channel"}
        </>
      }
    >
      {(close) => (
        <div class="drop">
          <CellView of={graph().channels} label="scanning for channels">
            {(d) => (
              <>
                <For each={d().list}>
                  {(entry) => (
                    <button
                      type="button"
                      class="chan"
                      disabled={s.port() === entry.port}
                      onClick={() => {
                        void s.connect(entry);
                        close();
                      }}
                    >
                      {channelLabel(entry)}
                    </button>
                  )}
                </For>
                <div class="kv">
                  {d().list.length === 0
                    ? d().source === "native"
                      ? "native host: no channels running"
                      : "no channels found (port scan — native host not installed?)"
                    : `${d().list.length} channel(s) via ${d().source === "native" ? "native host" : "port scan"}`}
                </div>
              </>
            )}
          </CellView>
          <Show when={s.port() !== undefined}>
            <button
              type="button"
              class="ghost"
              onClick={() => {
                s.disconnect();
                close();
              }}
            >
              disconnect
            </button>
          </Show>
          <Show when={s.bus().phase === "connected" && others().length > 0}>
            <div class="kv">peers ({others().length}):</div>
            <For each={others()}>
              {(peer) => (
                <div class="peer">
                  <span class="role">{peer.role ?? "view"}</span>{" "}
                  {peer.label ?? peer.url ?? peer.clientId}
                </div>
              )}
            </For>
          </Show>
          <Show when={s.status() !== ""}>
            <div class="kv">{s.status()}</div>
          </Show>
        </div>
      )}
    </Dropdown>
  );
}
