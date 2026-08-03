/**
 * channel-header.tsx — the channel chooser + status, at the top of every
 * panel entry. This is the retired extension's connection chip on the SAME
 * widget it was born in: the viz `Dropdown` (its refresh hook is the contract —
 * every open fires `onOpen`, so the list is repopulated on each click by
 * construction; outside-click and Escape dismiss). Dot + "name :port": green
 * = bus connected, amber = re-dialing, gray = unbound.
 *
 * HOW the list is populated is deliberately not this component's business —
 * `listChannels` is the seam. The channel-served page fetches the registry
 * mirror off its own origin; the extension panel asks the NATIVE HOST first
 * (the on-disk registry — finds channels with zero live ports known; the one
 * place native messaging is used) and falls back to the mirror. Switching is
 * likewise the entry's call: URL rebind vs remember-and-reboot.
 *
 * Explicit-port entry stays dropped (decided with the retired chip, 2026-07-12;
 * discovery covers the flows).
 */

import { Dropdown } from "@habemus-papadum/aiui-viz";
import { createSignal, For, Show } from "solid-js";

export const CHANNEL_HEADER_STYLES = `
  .aiui-chan { margin: 12px 12px 0; font: 13px system-ui; }
  .aiui-chan-chip { display: inline-flex; align-items: center; gap: 6px; cursor: pointer;
    font: inherit; color: inherit; background: transparent; padding: 3px 10px;
    border-radius: 999px; border: 1px solid color-mix(in srgb, currentColor 25%, transparent); }
  .aiui-chan-dot { width: 8px; height: 8px; border-radius: 50%; background: #9ca3af; }
  .aiui-chan-dot[data-phase="connected"] { background: #16a34a; }
  .aiui-chan-dot[data-phase="connecting"] { background: #d97706; }
  .aiui-chan-phase { opacity: 0.55; font-size: 11px; }
  .aiui-chan .aiui-dropdown-pop { background: Canvas; border-radius: 8px; padding: 6px;
    border: 1px solid color-mix(in srgb, currentColor 25%, transparent);
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35); width: max-content; }
  .aiui-chan-list { display: flex; flex-direction: column; align-items: stretch; gap: 2px; }
  .aiui-chan-list button { font: 12px system-ui; text-align: left; padding: 3px 8px;
    border-radius: 6px; border: none; background: transparent; color: inherit; cursor: pointer; }
  .aiui-chan-list button:hover {
    background: color-mix(in srgb, currentColor 12%, transparent); }
  /* The bound channel: full-strength and clickable (picking it again is an
     idempotent no-op — owner, 2026-07-19, replacing the confusing grayed
     row), named by the ✓ tail instead. */
  .aiui-chan-list button[data-current] { font-weight: 600; }
  .aiui-chan-current { font-size: 10px; color: #16a34a; margin-left: 8px; }
  .aiui-chan-note { font-size: 11px; opacity: 0.6; padding: 2px 4px; }
  /* Native messaging itself is broken — the LOUD tone (not "nothing running"). */
  .aiui-chan-note[data-tone="alarm"] { opacity: 1; color: #dc2626; font-weight: 600;
    max-width: 280px; }
`;

// The listing DATA contract + pure helpers moved to ../channel-listing.ts
// (2026-08-03): ext/channel.ts consumes `agentsWarning`, and reaching it
// through this COMPONENT file dragged solid-js into the discovery module
// graph — its reset-per-test reloads re-instantiated Solid and spammed the
// "multiple instances" warning across CI. Re-exported here so UI-side
// importers keep their path.
export {
  type AgentsStatusLike,
  agentsWarning,
  type ChannelEntry,
  type ChannelListing,
  channelLabel,
} from "../channel-listing";

import { type ChannelEntry, type ChannelListing, channelLabel } from "../channel-listing";

export function ChannelHeader(props: {
  /** The channel this panel is bound to (undefined = none found). */
  port: number | undefined;
  /** The session bus phase — the dot's color (a reactive read). */
  phase: () => "connected" | "connecting" | "closed";
  /** THE seam: how a list of channels is obtained is the entry's business. */
  listChannels: () => Promise<ChannelListing>;
  /** Rebind this panel to another channel (URL vs storage — the entry's call). */
  onSwitch: (port: number) => void;
}) {
  const [channels, setChannels] = createSignal<ChannelEntry[]>([], { ownedWrite: true });
  const [note, setNote] = createSignal("scanning…", { ownedWrite: true });
  const [tone, setTone] = createSignal<"info" | "alarm">("info", { ownedWrite: true });
  const refresh = async (): Promise<void> => {
    try {
      const listing = await props.listChannels();
      setChannels(listing.channels);
      if (listing.nativeHostError !== undefined) {
        // Native messaging is broken — say THAT, loudly, whether or not the
        // mirror fallback still found channels (cold-start discovery is dead
        // either way).
        setTone("alarm");
        setNote(
          `native messaging host unreachable — run \`aiui extension install-native-host\`, then reload the extension (${listing.nativeHostError})`,
        );
      } else if (listing.agentsWarning !== undefined) {
        // Channels work; their live session names don't. Loud but partial —
        // never a silent fallback to unnamed channels.
        setTone("alarm");
        setNote(listing.agentsWarning);
      } else {
        setTone("info");
        setNote(listing.channels.length === 0 ? "no channels running — run `aiui claude`" : "");
      }
    } catch {
      setChannels([]);
      setTone("info");
      setNote("discovery failed — is a channel running?");
    }
  };
  void refresh(); // once at mount, so the trigger can NAME the current channel

  const current = () => channels().find((entry) => entry.port === props.port);
  const label = () =>
    props.port === undefined
      ? "no channel"
      : ((c) => (c !== undefined ? channelLabel(c) : `:${props.port}`))(current());

  return (
    <div class="aiui-chan" data-testid="channel-header">
      <Dropdown
        class="aiui-chan-chip"
        label="channel connection"
        onOpen={() => void refresh()}
        trigger={
          <>
            <span class="aiui-chan-dot" data-phase={props.phase()} />
            {label()}
            <span class="aiui-chan-phase">{props.phase()}</span>
          </>
        }
      >
        {(close) => (
          <div class="aiui-chan-list">
            <For each={channels()}>
              {(entry) => (
                <button
                  type="button"
                  data-current={entry.port === props.port ? "" : undefined}
                  onClick={() => {
                    // Idempotent: re-picking the bound channel just closes —
                    // no rebind, no reload.
                    if (entry.port !== props.port) {
                      props.onSwitch(entry.port);
                    }
                    close();
                  }}
                >
                  {channelLabel(entry)}
                  <Show when={entry.port === props.port}>
                    <span class="aiui-chan-current">✓ connected</span>
                  </Show>
                </button>
              )}
            </For>
            <Show when={note() !== ""}>
              <div class="aiui-chan-note" data-tone={tone()}>
                {note()}
              </div>
            </Show>
          </div>
        )}
      </Dropdown>
    </div>
  );
}
