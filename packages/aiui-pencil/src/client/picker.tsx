/**
 * picker.tsx — `<SessionPicker/>`: the connect/pick/lost states.
 *
 * A session row leads with the host's session NAME when it announced one
 * ("courageous-beaver" — the only field that tells two panels apart), then
 * falls back to the presentation title, then the label. When a name leads,
 * the label joins the meta line so the row stays correlatable with the host.
 *
 * Busy rows stay JOINABLE (2026-07-25): the room supports several viewers per
 * host, and the disable was vestigial — its real-world effect was locking you
 * out of your own session for 30 s while the heartbeat reaped your ghost
 * (sleep, a Wi-Fi roam). "· busy" in the meta still says someone is on it.
 */

import type { JSX } from "@solidjs/web";
import { For, Show } from "solid-js";
import type { SessionInfo } from "../protocol";
import type { Phase } from "./app";

export interface SessionPickerProps {
  phase: Phase;
  sessions: SessionInfo[];
  onJoin: (id: string) => void;
}

export function SessionPicker(props: SessionPickerProps): JSX.Element {
  return (
    <div class="picker">
      <h1>remote pencil</h1>
      <Show when={props.phase === "connecting"}>
        <p>connecting…</p>
      </Show>
      <Show when={props.phase === "lost"}>
        <p>the host went away. waiting for it to come back…</p>
      </Show>
      <For each={props.sessions}>
        {(item) => (
          <button
            type="button"
            class="session"
            data-session={item.id}
            onClick={() => props.onJoin(item.id)}
          >
            {item.name ?? item.presentation?.title ?? item.label}
            {item.project ? ` — ${item.project}` : ""}
            <span class="session-meta">
              {item.name !== undefined ? `${item.label} · ` : ""}
              {item.id} · since {new Date(item.connectedAt).toLocaleTimeString()}
              {item.busy ? " · busy" : ""}
            </span>
          </button>
        )}
      </For>
      <Show when={props.phase === "picking" && props.sessions.length === 0}>
        <p>no hosts yet — open the Lab (or an aiui page) on the Mac.</p>
      </Show>
    </div>
  );
}
