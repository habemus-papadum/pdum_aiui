/**
 * panel.tsx — the panel as ordinary Solid components. Everything READS the
 * client's reactive accessors and WRITES only by dispatching (caps) or
 * through control ports (widgets); there is nothing to hand-sync.
 *
 * Three strips (owner review 2026-07-13):
 *  - the **command bar**: the mode tree flattened into depth rows — root is
 *    arm · step out · help; tiers appear as their parents engage. Labels
 *    are stable; lit carries "engaged"; enabled is the engine's derived
 *    verdict.
 *  - the **status pills**: internal state an expert wants at a glance —
 *    channel, capture stream, video sampling, ink pointer, key routing,
 *    REC (talk), mic permission, iPad paint clients. Claim statuses and
 *    context facts, rendered; nothing stored.
 *  - the **config strip**: the standing settings (stt, linter, log, shot
 *    flash) as control-bound widgets, always visible.
 */

import {
  type ControlBox,
  ControlSlider,
  ControlToggle,
  controlByName,
} from "@habemus-papadum/aiui-viz";
import type { BarItem, BarRow, ClaimStatus } from "@habemus-papadum/aiui-viz/modal";
import { createMemo, createSignal, For, Match, onCleanup, Repeat, Show, Switch } from "solid-js";
import type { IntentClient } from "../client";

export const PANEL_STYLES = `
  :root { color-scheme: light dark; }
  .aiui-panel { font: 13px/1.45 system-ui, sans-serif; padding: 12px; max-width: 460px; }
  .aiui-phase { display: inline-block; padding: 2px 10px; border-radius: 999px; font-weight: 600;
    border: 1px solid color-mix(in srgb, currentColor 35%, transparent); }
  .aiui-phase[data-phase="disarmed"] { opacity: 0.55; }
  .aiui-phase[data-phase="turn"], .aiui-phase[data-phase="tweak"] { color: #7c3aed; }
  .aiui-bar { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 8px; align-items: center; }
  .aiui-sep { opacity: 0.4; padding: 0 3px; font-weight: 600; user-select: none; }
  .aiui-cap { border: 1px solid color-mix(in srgb, currentColor 25%, transparent);
    border-radius: 6px; padding: 3px 8px; background: transparent; cursor: pointer; font: inherit;
    transition: background 250ms ease-out, border-color 250ms ease-out; }
  .aiui-cap[data-lit="true"] { background: color-mix(in srgb, #7c3aed 18%, transparent);
    border-color: #7c3aed; }
  .aiui-cap:active:not([disabled]) { transform: translateY(1px);
    background: color-mix(in srgb, currentColor 14%, transparent); }
  .aiui-cap[data-flash="true"] { background: color-mix(in srgb, #16a34a 22%, transparent);
    border-color: #16a34a; transition: none; }
  .aiui-cap[disabled] { opacity: 0.35; cursor: default; }
  .aiui-cap[data-tone="danger"] { border-color: color-mix(in srgb, #dc2626 60%, transparent); }
  .aiui-widget { display: inline-flex; align-items: center; gap: 4px; font-size: 12px;
    opacity: 0.9; }
  .aiui-widget select { font: inherit; }
  .aiui-widget .slider input { vertical-align: middle; }
  .aiui-pills { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 10px; }
  .aiui-pill { font-size: 11px; padding: 1px 8px; border-radius: 999px;
    border: 1px solid color-mix(in srgb, currentColor 20%, transparent); opacity: 0.6; }
  .aiui-pill[data-state="on"] { color: #16a34a; border-color: #16a34a; opacity: 1; }
  .aiui-pill[data-state="busy"] { color: #d97706; border-color: #d97706; opacity: 1; }
  .aiui-pill[data-state="err"] { color: #dc2626; border-color: #dc2626; opacity: 1; }
  .aiui-pill[data-state="live"] { color: #fff; background: #dc2626; border-color: #dc2626;
    opacity: 1; font-weight: 600; }
  .aiui-config { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 12px; padding-top: 8px;
    border-top: 1px solid color-mix(in srgb, currentColor 15%, transparent); }
  .aiui-help { margin-top: 10px; border-collapse: collapse; }
  .aiui-help td { padding: 1px 8px 1px 0; }
  .aiui-help kbd { border: 1px solid color-mix(in srgb, currentColor 30%, transparent);
    border-radius: 4px; padding: 0 5px; font: 11px ui-monospace, monospace; }
  .aiui-blip { margin-top: 8px; min-height: 1.2em; color: #dc2626; font-size: 12px; }
`;

export interface PanelProps {
  client: IntentClient;
  /** Called once with the blip sink (blips are UI-local display state). */
  registerBlipSink?: (sink: (key: string) => void) => void;
}

/** One status pill's view: stable label, varying state. */
interface Pill {
  label: string;
  state: "off" | "on" | "busy" | "err" | "live";
  detail?: string;
}

const claimPillState = (status: ClaimStatus | undefined): Pill["state"] => {
  switch (status?.phase) {
    case "active":
      return "on";
    case "pending":
    case "stale":
      return "busy";
    case "error":
      return "err";
    default:
      return "off";
  }
};

/** A control-bound widget (slider / select / toggle) by registered name. */
function BarWidget(props: { item: () => Extract<BarItem, { kind: "widget" }> }) {
  const ctl = createMemo(() => controlByName(props.item().control));
  return (
    <Show
      when={ctl()}
      fallback={<span class="aiui-widget">missing control: {props.item().control}</span>}
      keyed
    >
      {(control) => (
        <span class="aiui-widget" data-widget={props.item().control}>
          <Switch>
            <Match when={props.item().widget === "slider"}>
              <ControlSlider of={control as ControlBox<number>} label={props.item().label} />
            </Match>
            <Match when={props.item().widget === "toggle"}>
              <ControlToggle of={control as ControlBox<boolean>} label={props.item().label} />
            </Match>
            <Match when={props.item().widget === "select"}>
              <label>
                {props.item().label}
                <select
                  name={props.item().control}
                  disabled={!props.item().enabled}
                  onChange={(e) => control.set(e.currentTarget.value as never)}
                >
                  <For each={(control.meta.options ?? []) as readonly string[]}>
                    {(option) => (
                      <option value={option} selected={control.get() === option}>
                        {option}
                      </option>
                    )}
                  </For>
                </select>
              </label>
            </Match>
          </Switch>
        </span>
      )}
    </Show>
  );
}

/** The whole panel: pill · bar rows · status pills · help · blip · config. */
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

  // Verb caps move no region — acknowledge the tap itself with a brief flash.
  const [flashed, setFlashed] = createSignal<string | undefined>(undefined, { ownedWrite: true });
  let flashTimer: ReturnType<typeof setTimeout> | undefined;
  const tapCap = (command: string, payload?: unknown): void => {
    client.dispatch(command, payload);
    setFlashed(command);
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => setFlashed(undefined), 220);
  };
  onCleanup(() => clearTimeout(flashTimer));

  /** The expert strip: claim statuses + context facts, stable labels. */
  const pills = createMemo((): Pill[] => {
    const state = client.state();
    const ctx = client.context();
    const claims = client.claimStatuses();
    const talk = state.talk as string;
    return [
      { label: "channel", state: ctx.connected ? "on" : "off" },
      {
        label: "mic",
        state: ctx.micGranted === undefined ? "off" : ctx.micGranted ? "on" : "err",
        detail: ctx.micGranted === undefined ? "not asked" : ctx.micGranted ? "granted" : "denied",
      },
      {
        label: "rec",
        state: talk === "off" ? "off" : state.micMuted === true ? "busy" : "live",
        detail: talk === "off" ? undefined : state.micMuted === true ? `${talk} · muted` : talk,
      },
      { label: "stream", state: claimPillState(claims.tabStream) },
      { label: "video", state: claimPillState(claims.videoSample) },
      { label: "ink", state: claimPillState(claims.inkPointer) },
      { label: "keys", state: claimPillState(claims.keyRouting) },
      { label: "ipad", state: ctx.paintClients > 0 ? "on" : "off", detail: `${ctx.paintClients}` },
    ];
  });

  // Keyboard shortcuts are never cap TEXT (owner): keys live in the tooltip
  // and the help table; the cap shows icon + stable label.
  //
  // Rendered POSITION-KEYED (<Repeat>, fine-grained): the DOM node at a
  // position PERSISTS while its attributes update in place. This is load-
  // bearing for the push-to-talk hold cap — a reference-keyed <For> would
  // re-create the button the moment its own lit state flips, detaching the
  // node mid-press and losing the pointerup (found live).
  const cap = (item: () => Extract<BarItem, { kind: "cap" }> | undefined) => {
    const hold = () => item()?.hold;
    return (
      <button
        type="button"
        class="aiui-cap"
        data-command={item()?.command}
        data-lit={item()?.lit ? "true" : "false"}
        data-flash={flashed() === item()?.command ? "true" : "false"}
        data-tone={item()?.hint.tone}
        data-hold={hold() !== undefined ? "true" : "false"}
        disabled={!item()?.enabled}
        title={((h) => (h === undefined ? "" : h.key !== "" ? `${h.key} — ${h.label}` : h.label))(
          item()?.hint,
        )}
        onClick={() => {
          const it = item();
          if (it !== undefined && it.hold === undefined) {
            tapCap(it.command, it.payload);
          }
        }}
        onPointerDown={() => {
          const h = hold();
          if (h !== undefined) {
            client.dispatch(h.down);
          }
        }}
        onPointerUp={() => {
          const h = hold();
          if (h !== undefined) {
            client.dispatch(h.up);
          }
        }}
        onPointerLeave={() => {
          const h = hold();
          if (h !== undefined && item()?.lit) {
            client.dispatch(h.up);
          }
        }}
      >
        {item()?.hint.icon} {item()?.hint.label}
      </button>
    );
  };

  const renderItem = (item: () => BarItem | undefined) => (
    <>
      <Show when={item()?.kind === "cap"}>
        {cap(item as () => Extract<BarItem, { kind: "cap" }> | undefined)}
      </Show>
      <Show when={item()?.kind === "widget"}>
        <BarWidget item={item as () => Extract<BarItem, { kind: "widget" }>} />
      </Show>
    </>
  );

  const rows = createMemo((): BarRow[] => client.bar());

  return (
    <div class="aiui-panel" data-testid="aiui-panel">
      <style>{PANEL_STYLES}</style>
      <span class="aiui-phase" data-phase={phase()} data-testid="phase-pill">
        {phase()}
      </span>

      {/* The tree, flattened into ONE wrapping flow: depth tiers joined by a
          chevron divider, so a one-cap tier (turn) never sits alone on a
          line. The model still yields rows; only the presentation joins. */}
      <div class="aiui-bar" data-testid="command-bar">
        <Repeat count={rows().length}>
          {(rowIndex) => {
            const row = () => rows()[rowIndex];
            return (
              <>
                <Show when={rowIndex > 0}>
                  <span class="aiui-sep" aria-hidden="true">
                    ›
                  </span>
                </Show>
                <Repeat count={row()?.items.length ?? 0}>
                  {(itemIndex) => renderItem(() => row()?.items[itemIndex])}
                </Repeat>
              </>
            );
          }}
        </Repeat>
      </div>

      <div class="aiui-pills" data-testid="pills">
        <For each={pills()}>
          {(pill) => (
            <span
              class="aiui-pill"
              data-pill={pill.label}
              data-state={pill.state}
              title={pill.detail}
            >
              {pill.label}
            </span>
          )}
        </For>
      </div>

      <Show when={client.state().help === true}>
        <table class="aiui-help" data-testid="keymap-help">
          <tbody>
            <Show
              when={client.hints().length > 0}
              fallback={
                <tr>
                  <td>
                    <kbd>activate</kbd>
                  </td>
                  <td />
                  <td>
                    the host's activation shortcut (or the caps above) grants + opens a turn — the
                    keys live in-turn
                  </td>
                </tr>
              }
            >
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
            </Show>
          </tbody>
        </table>
      </Show>

      <div class="aiui-blip" data-testid="blip">
        <Show when={blip()}>{(key) => <>swallowed: {key()}</>}</Show>
      </div>

      <div class="aiui-config" data-testid="config-strip">
        <Repeat count={client.configStrip().length}>
          {(rowIndex) => {
            const row = () => client.configStrip()[rowIndex];
            return (
              <Repeat count={row()?.items.length ?? 0}>
                {(itemIndex) => renderItem(() => row()?.items[itemIndex])}
              </Repeat>
            );
          }}
        </Repeat>
      </div>
    </div>
  );
}
