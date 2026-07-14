/**
 * channel-header.tsx — the channel chooser + status, at the top of every
 * panel entry. The old extension's connection chip (decided 2026-07-12: dot +
 * "name :port"; green = bus connected, amber = re-dialing, gray = unbound;
 * opening the dropdown rescans; the body lists every discovered channel),
 * re-expressed as plain Solid over the registry mirror — one live channel's
 * `/debug/api/channels` enumerates the rest.
 *
 * What SWITCHING means is the entry's business, not this component's: the
 * channel-served page rebinds by URL (`?channel=<port>`, then reload — its
 * origin IS a channel); the extension panel remembers the port and reboots.
 * Explicit-port entry stays dropped (decided with the old chip; discovery
 * covers the flows).
 */

import { createSignal, For, Show } from "solid-js";

export const CHANNEL_HEADER_STYLES = `
  .aiui-chan { margin: 12px 12px 0; font: 13px system-ui; }
  .aiui-chan summary { list-style: none; display: inline-flex; align-items: center; gap: 6px;
    cursor: pointer; padding: 3px 10px; border-radius: 999px;
    border: 1px solid color-mix(in srgb, currentColor 25%, transparent); }
  .aiui-chan summary::-webkit-details-marker { display: none; }
  .aiui-chan-dot { width: 8px; height: 8px; border-radius: 50%; background: #9ca3af; }
  .aiui-chan-dot[data-phase="connected"] { background: #16a34a; }
  .aiui-chan-dot[data-phase="connecting"] { background: #d97706; }
  .aiui-chan-phase { opacity: 0.55; font-size: 11px; }
  .aiui-chan-list { display: flex; flex-direction: column; align-items: flex-start; gap: 2px;
    margin: 6px 0 0 8px; }
  .aiui-chan-list button { font: 12px system-ui; padding: 2px 8px; border-radius: 6px;
    border: 1px solid color-mix(in srgb, currentColor 20%, transparent); background: transparent;
    cursor: pointer; }
  .aiui-chan-list button[disabled] { opacity: 0.5; cursor: default; font-weight: 600; }
  .aiui-chan-note { font-size: 11px; opacity: 0.6; padding: 2px 0; }
`;

/** One channel, as `/debug/api/channels` lists them (the registry mirror). */
export interface ChannelEntry {
  port: number;
  tag?: string;
  cwd?: string;
  pid?: number;
  /** A standalone `aiui serve`: reachable, but with no session behind it. */
  debug?: boolean;
}

/** "project :port" — the cwd tail names the session (ports are noise alone). */
export const channelLabel = (entry: ChannelEntry): string => {
  const name = entry.cwd?.split("/").filter(Boolean).at(-1) ?? "channel";
  return `${name} :${entry.port}${entry.debug ? " (debug)" : ""}`;
};

export function ChannelHeader(props: {
  /** The channel this panel is bound to (undefined = none found). */
  port: number | undefined;
  /** The session bus phase — the dot's color (a reactive read). */
  phase: () => "connected" | "connecting" | "closed";
  /** Where the registry mirror answers ("" = same origin). */
  baseUrl?: string;
  /** Rebind this panel to another channel (URL vs storage — the entry's call). */
  onSwitch: (port: number) => void;
}) {
  const [channels, setChannels] = createSignal<ChannelEntry[]>([], { ownedWrite: true });
  const [note, setNote] = createSignal("scanning…", { ownedWrite: true });
  const refresh = async (): Promise<void> => {
    try {
      const res = await fetch(`${props.baseUrl ?? ""}/debug/api/channels`);
      const body = (await res.json()) as { channels?: ChannelEntry[] };
      setChannels(body.channels ?? []);
      setNote(`${body.channels?.length ?? 0} channel(s) in the registry`);
    } catch {
      setChannels([]);
      setNote("registry unreachable — is a channel running?");
    }
  };
  void refresh();

  const current = () => channels().find((entry) => entry.port === props.port);
  const label = () =>
    props.port === undefined
      ? "no channel"
      : ((c) => (c !== undefined ? channelLabel(c) : `:${props.port}`))(current());

  return (
    <div class="aiui-chan" data-testid="channel-header">
      <details
        onToggle={(event) => {
          // The old chip's rule: opening the dropdown IS the rescan.
          if ((event.currentTarget as HTMLDetailsElement).open) {
            void refresh();
          }
        }}
      >
        <summary title="channel connection — click to list/switch">
          <span class="aiui-chan-dot" data-phase={props.phase()} />
          {label()}
          <span class="aiui-chan-phase">{props.phase()}</span>
        </summary>
        <div class="aiui-chan-list">
          <For each={channels()}>
            {(entry) => (
              <button
                type="button"
                disabled={entry.port === props.port}
                onClick={() => props.onSwitch(entry.port)}
              >
                {channelLabel(entry)}
              </button>
            )}
          </For>
          <Show when={channels().length === 0}>
            <div class="aiui-chan-note">{note()}</div>
          </Show>
        </div>
      </details>
    </div>
  );
}
