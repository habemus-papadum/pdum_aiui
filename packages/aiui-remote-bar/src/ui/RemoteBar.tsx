/**
 * RemoteBar.tsx — the bar-only remote as ordinary Solid components. Everything
 * here READS the client (`rows()`, `claims()`, `phase()`, `status()` are reactive
 * accessors) and WRITES only by calling `join`/`dispatch`/`leave`. The component
 * IS the projection of the host's bar — recomputed per frame the relay delivers,
 * nothing to keep in sync. Same shape as the intent panel; different sink (a
 * socket, not a local engine).
 *
 * Styling is a CSS-class contract (like aiui-viz's widgets): the classes below
 * are the API, {@link REMOTE_BAR_STYLES} is a drop-in default an app can replace.
 */

import { For, Show } from "solid-js";
import type { RemoteBarClient } from "./client";

export const REMOTE_BAR_STYLES = `
  .aiui-remote-bar { font: 13px/1.45 var(--aiui-sans, system-ui, sans-serif); padding: 12px; max-width: 460px;
    color: var(--aiui-ink, inherit); }
  .aiui-remote-status { font-size: 11px; opacity: 0.7; margin-bottom: 8px; }
  .aiui-remote-phase { display: inline-block; padding: 2px 10px; border-radius: 999px; font-weight: 600;
    border: 1px solid var(--aiui-hairline, color-mix(in srgb, currentColor 35%, transparent)); }
  .aiui-remote-phase[data-phase="turn"], .aiui-remote-phase[data-phase="tweak"] { color: var(--aiui-accent, #7c3aed); }
  .aiui-remote-rows { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 10px; }
  .aiui-remote-cap { border: 1px solid var(--aiui-hairline, color-mix(in srgb, currentColor 25%, transparent));
    border-radius: var(--aiui-radius, 6px); padding: 3px 8px; background: transparent; cursor: pointer; font: inherit;
    touch-action: manipulation; -webkit-tap-highlight-color: transparent;
    transition: transform 60ms ease-out, background 60ms ease-out, border-color 60ms ease-out; }
  .aiui-remote-cap:active:not([disabled]) { transform: scale(0.92);
    background: var(--aiui-ghost, color-mix(in srgb, currentColor 14%, transparent));
    border-color: var(--aiui-accent, #7c3aed); }
  .aiui-remote-cap[data-lit="true"] { background: var(--aiui-ink, CanvasText);
    color: var(--aiui-surface, Canvas); border-color: var(--aiui-ink, CanvasText); }
  .aiui-remote-cap[disabled] { opacity: 0.4; cursor: default; }
  .aiui-remote-cap[data-tone="danger"] { border-color: var(--aiui-alarm, #dc2626); }
  .aiui-remote-claims { margin-top: 10px; display: flex; flex-wrap: wrap; gap: 4px; }
  .aiui-remote-claim { font-size: 11px; padding: 1px 7px; border-radius: 999px;
    border: 1px solid var(--aiui-hairline, color-mix(in srgb, currentColor 20%, transparent)); opacity: 0.75; }
  .aiui-remote-claim[data-phase="active"] { color: var(--aiui-ok, #16a34a); opacity: 1; }
  .aiui-remote-claim[data-phase="pending"] { color: var(--aiui-warn, #d97706); opacity: 1; }
  .aiui-remote-claim[data-phase="error"] { color: var(--aiui-alarm, #dc2626); opacity: 1; }
  .aiui-remote-sessions { display: flex; flex-direction: column; gap: 4px; margin-top: 8px; }
  .aiui-remote-session { text-align: left; border: 1px solid var(--aiui-hairline, color-mix(in srgb, currentColor 25%, transparent));
    border-radius: var(--aiui-radius, 6px); padding: 6px 10px; background: transparent; cursor: pointer; font: inherit;
    touch-action: manipulation; -webkit-tap-highlight-color: transparent; }
  .aiui-remote-session:active { background: var(--aiui-ghost, color-mix(in srgb, currentColor 12%, transparent)); }
  .aiui-remote-session small { display: block; opacity: 0.6; }
  .aiui-remote-note { margin-top: 8px; opacity: 0.8; }
  .aiui-remote-note[data-tone="error"] { color: var(--aiui-alarm, #dc2626); }
  .aiui-remote-leave { margin-top: 10px; font-size: 11px; background: none; border: none;
    color: inherit; opacity: 0.6; cursor: pointer; text-decoration: underline; padding: 0; }
`;

export interface RemoteBarProps {
  client: RemoteBarClient;
}

/** The list of connectable hosts, when not joined. */
function SessionList(props: { client: RemoteBarClient }) {
  return (
    <Show
      when={props.client.sessions().length > 0}
      fallback={
        <div class="aiui-remote-note" data-testid="empty">
          Waiting for a host…
        </div>
      }
    >
      <div class="aiui-remote-sessions" data-testid="sessions">
        <For each={props.client.sessions()}>
          {(session) => (
            <button
              type="button"
              class="aiui-remote-session"
              data-host={session.id}
              onClick={() => props.client.join(session.id)}
            >
              {session.name ?? session.label}
              <Show when={session.name !== undefined}>
                <small>{session.label}</small>
              </Show>
              <Show when={session.project}>{(project) => <small>{project()}</small>}</Show>
            </button>
          )}
        </For>
      </div>
    </Show>
  );
}

/** The projected bar: phase pill · cap row · claim chips · leave. */
function JoinedBar(props: { client: RemoteBarClient }) {
  const { client } = props;
  return (
    <div data-testid="joined">
      <Show when={client.phase()}>
        {(phase) => (
          <span class="aiui-remote-phase" data-phase={phase()} data-testid="phase-pill">
            {phase()}
          </span>
        )}
      </Show>

      <div class="aiui-remote-rows" data-testid="command-bar">
        <For each={client.rows()}>
          {(cap) => (
            <button
              type="button"
              class="aiui-remote-cap"
              data-command={cap.command}
              data-lit={cap.lit ? "true" : "false"}
              data-tone={cap.hint.tone}
              disabled={!cap.enabled}
              title={`${cap.hint.key} — ${cap.hint.label}`}
              onClick={() => client.dispatch(cap.command, cap.payload)}
            >
              {cap.hint.icon ?? cap.hint.key} {cap.hint.label}
            </button>
          )}
        </For>
      </div>

      <div class="aiui-remote-claims" data-testid="claims">
        <For each={Object.entries(client.claims())}>
          {([name, phase]) => (
            <span class="aiui-remote-claim" data-claim={name} data-phase={phase}>
              {name}: {phase}
            </span>
          )}
        </For>
      </div>

      <button type="button" class="aiui-remote-leave" onClick={() => client.leave()}>
        leave
      </button>
    </div>
  );
}

/** The whole remote: connection line, then either the bar or the host list. */
export function RemoteBar(props: RemoteBarProps) {
  const { client } = props;
  return (
    <div class="aiui-remote-bar" data-testid="aiui-remote-bar">
      <style>{REMOTE_BAR_STYLES}</style>

      <div class="aiui-remote-status" data-testid="connection" data-status={client.status()}>
        {client.status()}
      </div>

      <Show
        when={client.status() === "joined"}
        fallback={
          <>
            <Show when={client.status() === "hostGone"}>
              <div class="aiui-remote-note" data-tone="error" data-testid="host-gone">
                The host disconnected.
              </div>
            </Show>
            <Show when={client.rejectedReason()}>
              {(reason) => (
                <div class="aiui-remote-note" data-tone="error" data-testid="rejected">
                  Join refused: {reason()}
                </div>
              )}
            </Show>
            <SessionList client={client} />
          </>
        }
      >
        <JoinedBar client={client} />
      </Show>
    </div>
  );
}
