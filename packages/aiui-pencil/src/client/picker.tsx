/**
 * picker.tsx — `<SessionPicker/>`: the connect/pick/lost states.
 *
 * A session row shows the host's presentation title when it declared one
 * (falling back to the label), plus the project and liveness meta.
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
            disabled={item.busy}
            onClick={() => props.onJoin(item.id)}
          >
            {item.presentation?.title ?? item.label}
            {item.project ? ` — ${item.project}` : ""}
            <span class="session-meta">
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
