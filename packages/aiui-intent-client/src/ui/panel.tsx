/**
 * panel.tsx — the panel as ordinary Solid components. Everything READS the
 * client's reactive accessors and WRITES only by dispatching (caps) or
 * through control ports (widgets); there is nothing to hand-sync.
 *
 * Three strips (owner review 2026-07-13):
 *  - the **command bar**: the mode tree rendered DEPTH-FIRST — root is
 *    arm · step out · help; a lit parent's revealed children flow inline
 *    right after it, bracketed by a faint depth-shaded group so a linear row
 *    of caps still shows its hierarchy. Labels are stable; lit carries
 *    "engaged"; enabled is the engine's derived verdict.
 *  - the **status pills**: internal state an expert wants at a glance —
 *    channel, capture stream, video sampling, ink pointer, key routing,
 *    REC (talk), mic permission, iPad paint clients. Claim statuses and
 *    context facts, rendered; nothing stored.
 *  - the **config strip**: the standing settings (stt, linter, log, shot
 *    flash) as control-bound widgets, always visible.
 */

import { type ControlBox, ControlToggle, controlByName } from "@habemus-papadum/aiui-viz";
import type { BarItem, BarTreeNode, ClaimStatus } from "@habemus-papadum/aiui-viz/modal";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  onCleanup,
  Repeat,
  Show,
  Switch,
} from "solid-js";
import type { IntentClient } from "../client";

export const PANEL_STYLES = `
  :root { color-scheme: light dark; }
  .aiui-panel { font: 13px/1.45 system-ui, sans-serif; padding: 12px; max-width: 460px; }
  .aiui-bar { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
  .aiui-sep { opacity: 0.4; padding: 0 3px; font-weight: 600; user-select: none; }
  /* A group brackets a lit parent with its revealed children: thin left/right
     rules and a faint tint that DEEPENS with nesting depth, so a linear row of
     caps still shows which belong together and how deep. Children flow inline
     right after their parent (depth-first), the group wraps as one unit. */
  .aiui-group { display: inline-flex; flex-wrap: wrap; gap: 4px; align-items: center;
    padding: 2px 5px; border-radius: 7px;
    border-left: 1px solid color-mix(in srgb, currentColor 22%, transparent);
    border-right: 1px solid color-mix(in srgb, currentColor 22%, transparent);
    background: color-mix(in srgb, currentColor 4%, transparent); }
  .aiui-group[data-depth="1"] { background: color-mix(in srgb, currentColor 7%, transparent); }
  .aiui-group[data-depth="2"] { background: color-mix(in srgb, currentColor 10%, transparent); }
  .aiui-group[data-depth="3"] { background: color-mix(in srgb, currentColor 13%, transparent); }
  .aiui-group[data-depth="4"] { background: color-mix(in srgb, currentColor 16%, transparent); }
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
  /* The ring pill mirrors the ON-PAGE dot, not the generic pill palette
     (cdp/page-script.ts assertRing / ext/content.ts — the source of these
     literals): steady PURPLE #7c3aed = armed, breathing RED #dc2626 = turn,
     same 1.6s ease-in-out rhythm. The two can't share a clock across
     documents, so what aligns is color + cadence, not phase. */
  .aiui-pill[data-pill="ring"][data-state="on"] { color: #7c3aed; border-color: #7c3aed; }
  .aiui-pill[data-pill="ring"][data-state="live"] {
    animation: aiui-ring-breathe 1.6s ease-in-out infinite; }
  @keyframes aiui-ring-breathe { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
  .aiui-config { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 8px; padding-top: 6px;
    border-top: 1px solid color-mix(in srgb, currentColor 15%, transparent); }
  .aiui-help { margin-top: 10px; border-collapse: collapse; }
  .aiui-help td { padding: 1px 8px 1px 0; }
  .aiui-help kbd { border: 1px solid color-mix(in srgb, currentColor 30%, transparent);
    border-radius: 4px; padding: 0 5px; font: 11px ui-monospace, monospace; }
  .aiui-blip { margin-top: 6px; color: #dc2626; font-size: 12px; }
  .aiui-meter { display: inline-block; width: 64px; height: 8px; border-radius: 4px;
    border: 1px solid color-mix(in srgb, currentColor 25%, transparent); overflow: hidden;
    vertical-align: middle; }
  .aiui-meter > div { height: 100%; background: #dc2626; transition: width 80ms linear; }
`;

export interface PanelProps {
  client: IntentClient;
  /** Called once with the blip sink (blips are UI-local display state). */
  registerBlipSink?: (sink: (key: string) => void) => void;
  /** The live mic level 0..1 (talk.level) — renders the REC meter while talking. */
  micLevel?: () => number;
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
              {/* Bare range, no label/readout — text beside a slider relayouts
                  as the value moves (owner); the tooltip carries the name. */}
              <input
                type="range"
                name={props.item().control}
                min={control.meta.min}
                max={control.meta.max}
                step={control.meta.step}
                value={control.get() as number}
                title={`${props.item().label}: ${control.get()}${control.meta.unit ?? ""}`}
                disabled={!props.item().enabled}
                onInput={(e) => control.set(Number(e.currentTarget.value) as never)}
              />
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

  const [blip, setBlip] = createSignal<string | undefined>(undefined, { ownedWrite: true });
  let blipTimer: ReturnType<typeof setTimeout> | undefined;
  props.registerBlipSink?.((key) => {
    setBlip(key);
    clearTimeout(blipTimer);
    blipTimer = setTimeout(() => setBlip(undefined), 500);
  });
  onCleanup(() => clearTimeout(blipTimer));

  // The REC meter: poll talk.level while a talk window is open (display
  // state at display cadence — the machine is untouched).
  const [micLevel, setMicLevel] = createSignal(0, { ownedWrite: true });
  let meterTimer: ReturnType<typeof setInterval> | undefined;
  createEffect(
    () => client.state().talk !== "off" && props.micLevel !== undefined,
    (talking) => {
      clearInterval(meterTimer);
      if (talking) {
        meterTimer = setInterval(() => setMicLevel(props.micLevel?.() ?? 0), 100);
      } else {
        setMicLevel(0);
      }
    },
  );
  onCleanup(() => clearInterval(meterTimer));

  // Verb caps move no region — acknowledge the tap itself with a brief flash.
  const [flashed, setFlashed] = createSignal<string | undefined>(undefined, { ownedWrite: true });
  let flashTimer: ReturnType<typeof setTimeout> | undefined;
  const tapCap = (command: string, payload?: unknown): void => {
    client.dispatch(command, payload);
    setFlashed(command);
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => setFlashed(undefined), 120);
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
      {
        // The ring's own three states, from the claim's DESIRE: off · steady
        // (armed) · breathing (in-turn) — the page indicator's exact contract.
        label: "ring",
        state: ((desire) => (desire?.on !== true ? "off" : desire.turnTone ? "live" : "on"))(
          claims.ring?.desire as { on?: boolean; turnTone?: boolean } | undefined,
        ),
        detail: "off · purple=armed · red pulse=turn (the on-page dot, mirrored)",
      },
      {
        label: "sel",
        state: ctx.selectionPresent ? "on" : "off",
        detail: ctx.selectionPresent ? "the page has a live selection" : "no selection",
      },
      {
        label: "aiui",
        state: ctx.aiuiPage ? "on" : "off",
        detail: ctx.aiuiPage ? "aiui-instrumented (locate/jump capable)" : "not instrumented",
      },
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
        title={(() => {
          const it = item();
          if (it === undefined) {
            return "";
          }
          // UI copy for the one cap whose disablement has a REMEDY the user
          // can take right now (owner, 2026-07-14).
          if (it.command === "selection" && !it.enabled) {
            return "no selection on the page — consider tweak mode (t) and selecting something";
          }
          const h = it.hint;
          return h.key !== "" ? `${h.key} — ${h.label}` : h.label;
        })()}
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

  const forest = createMemo((): BarTreeNode[] => client.bar());

  // The tree rendered DEPTH-FIRST: each node in declaration order, and a node
  // that has revealed children becomes a bracketed group wrapping the parent
  // cap and — recursively — its subtree, so the flow reads left-to-right as
  // one linear row of caps whose thin borders show the groupings. A leaf
  // renders bare; the Show flips it into a group exactly when children appear.
  const renderBranch = (nodes: () => BarTreeNode[]) => (
    <Repeat count={nodes().length}>
      {(index) => {
        const node = () => nodes()[index];
        return (
          <Show when={(node()?.children.length ?? 0) > 0} fallback={renderItem(() => node()?.item)}>
            <span class="aiui-group" data-depth={node()?.depth}>
              {renderItem(() => node()?.item)}
              {renderBranch(() => node()?.children ?? [])}
            </span>
          </Show>
        );
      }}
    </Repeat>
  );

  return (
    <div class="aiui-panel" data-testid="aiui-panel">
      <style>{PANEL_STYLES}</style>
      {/* The mode tree, depth-first: a parent sits right before its children,
          and a lit parent's subtree is bracketed by a faint depth-shaded
          group — the vertical rules are the only hint that a linear row of
          caps is actually a hierarchy. */}
      <div class="aiui-bar" data-testid="command-bar">
        {renderBranch(forest)}
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

      <Show when={blip()}>
        {(key) => (
          <div class="aiui-blip" data-testid="blip">
            swallowed: {key()}
          </div>
        )}
      </Show>

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

      {/* Pills BELOW the config strip (owner, 2026-07-14: bar → config → pills). */}
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
        <Show when={client.state().talk !== "off" && props.micLevel !== undefined}>
          <span class="aiui-meter" data-testid="mic-meter" title="mic level">
            <div style={`width: ${Math.round(Math.min(1, micLevel()) * 100)}%`} />
          </span>
        </Show>
      </div>
    </div>
  );
}
