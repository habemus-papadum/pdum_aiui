/**
 * panel.tsx — the panel as ordinary Solid components (ground rule: JSX
 * everywhere a DOM node is born; no imperative class-islands, no hand-called
 * syncs). Everything here READS the client — `client.state()`, `bar()`,
 * `hints()`, `claimStatuses()` are reactive accessors — and WRITES only by
 * dispatching. There is nothing to keep in sync; the components ARE the
 * projection, recomputed per commit.
 */

import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import type { IntentClient } from "../client";

export const PANEL_STYLES = `
  :root { color-scheme: light dark; }
  .aiui-panel { font: 13px/1.45 system-ui, sans-serif; padding: 12px; max-width: 420px; }
  .aiui-phase { display: inline-block; padding: 2px 10px; border-radius: 999px; font-weight: 600;
    border: 1px solid color-mix(in srgb, currentColor 35%, transparent); }
  .aiui-phase[data-phase="disarmed"] { opacity: 0.55; }
  .aiui-phase[data-phase="turn"], .aiui-phase[data-phase="tweak"] { color: #7c3aed; }
  .aiui-bar { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 10px; }
  .aiui-cap { border: 1px solid color-mix(in srgb, currentColor 25%, transparent);
    border-radius: 6px; padding: 3px 8px; background: transparent; cursor: pointer; font: inherit; }
  .aiui-cap[data-lit="true"] { background: color-mix(in srgb, #7c3aed 18%, transparent);
    border-color: #7c3aed; }
  .aiui-cap[disabled] { opacity: 0.4; cursor: default; }
  .aiui-cap[data-tone="danger"] { border-color: color-mix(in srgb, #dc2626 60%, transparent); }
  .aiui-claims { margin-top: 10px; display: flex; flex-wrap: wrap; gap: 4px; }
  .aiui-claim { font-size: 11px; padding: 1px 7px; border-radius: 999px;
    border: 1px solid color-mix(in srgb, currentColor 20%, transparent); opacity: 0.75; }
  .aiui-claim[data-phase="active"] { color: #16a34a; opacity: 1; }
  .aiui-claim[data-phase="pending"] { color: #d97706; opacity: 1; }
  .aiui-claim[data-phase="error"] { color: #dc2626; opacity: 1; }
  .aiui-help { margin-top: 10px; border-collapse: collapse; }
  .aiui-help td { padding: 1px 8px 1px 0; }
  .aiui-help kbd { border: 1px solid color-mix(in srgb, currentColor 30%, transparent);
    border-radius: 4px; padding: 0 5px; font: 11px ui-monospace, monospace; }
  .aiui-blip { margin-top: 8px; min-height: 1.2em; color: #dc2626; font-size: 12px; }
`;

export interface PanelProps {
  client: IntentClient;
  /**
   * Called once with the blip sink so the page bootstrap can route the
   * client's `onBlip` here (the blip is transient DISPLAY state — it lives
   * in the component, not the machine).
   */
  registerBlipSink?: (sink: (key: string) => void) => void;
}

/** The whole panel: pill · bar · claim chips · help table · blip line. */
export function Panel(props: PanelProps) {
  const { client } = props;
  const phase = createMemo(() => String(client.state().phase));

  const [blip, setBlip] = createSignal<string | undefined>(undefined, { ownedWrite: true });
  let blipTimer: ReturnType<typeof setTimeout> | undefined;
  props.registerBlipSink?.((key) => {
    setBlip(key);
    clearTimeout(blipTimer);
    blipTimer = setTimeout(() => setBlip(undefined), 500);
  });
  onCleanup(() => clearTimeout(blipTimer));

  return (
    <div class="aiui-panel" data-testid="aiui-panel">
      <style>{PANEL_STYLES}</style>
      <span class="aiui-phase" data-phase={phase()} data-testid="phase-pill">
        {phase()}
      </span>

      <div class="aiui-bar" data-testid="command-bar">
        <For each={client.bar()}>
          {(cap) => (
            <button
              type="button"
              class="aiui-cap"
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

      <div class="aiui-claims" data-testid="claims">
        <For each={Object.entries(client.claimStatuses())}>
          {([name, status]) => (
            <span class="aiui-claim" data-claim={name} data-phase={status.phase}>
              {name}: {status.phase}
            </span>
          )}
        </For>
      </div>

      <Show when={client.state().help === true}>
        <table class="aiui-help" data-testid="keymap-help">
          <tbody>
            <For each={client.hints()}>
              {(hint) => (
                <tr>
                  <td>
                    <kbd>{hint.key}</kbd>
                  </td>
                  <td>{hint.icon}</td>
                  <td>{hint.label}</td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </Show>

      <div class="aiui-blip" data-testid="blip">
        <Show when={blip()}>{(key) => <>swallowed: {key()}</>}</Show>
      </div>
    </div>
  );
}
