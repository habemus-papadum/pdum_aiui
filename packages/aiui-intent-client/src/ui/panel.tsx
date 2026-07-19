/**
 * panel.tsx — the panel orchestrator. Everything READS the client's reactive
 * accessors and WRITES only by dispatching (caps) or through control ports
 * (widgets); there is nothing to hand-sync. Panel composes three strips plus
 * the help table and blip, in the owner-decided order (bar → help → blip →
 * config → pills, 2026-07-14), and emits PANEL_STYLES once.
 *
 * The strips live in their own modules (owner review 2026-07-13):
 *  - the **command bar** (`bar.tsx`): the mode tree rendered DEPTH-FIRST — a
 *    lit parent's revealed children flow inline, bracketed by a faint
 *    depth-shaded group. Owns the shared CapRuntime (the tap-flash closure),
 *    created ONCE here and passed to both CommandBar and ConfigStrip.
 *  - the **status pills** (`pills.tsx`): internal state an expert wants at a
 *    glance (channel · mic · rec · stream · video · ink · keys · ring · sel ·
 *    aiui · ipad) plus the REC meter. Claim statuses and context facts,
 *    rendered; nothing stored.
 *  - the **config strip** (`config-strip.tsx`): the standing settings (stt,
 *    linter, log, shot flash) as control-bound widgets, always visible, with
 *    the lint-lifecycle pulse dot.
 *
 * PANEL_STYLES is base CSS (:root/.aiui-panel, help, blip) concatenated with
 * BAR_STYLES + PILLS_STYLES + CONFIG_STRIP_STYLES, in that order — the pill
 * cascade (generic palette before the ring overrides) stays whole inside
 * PILLS_STYLES.
 */

import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import type { IntentClient } from "../client";
import { hintsFor } from "../keys";
import type { LinterPulseView } from "../linter-pulse";
import { BAR_STYLES, CommandBar, createCapRuntime } from "./bar";
import { CONFIG_STRIP_STYLES, ConfigStrip, type LintControlHandlers } from "./config-strip";
import { PILLS_STYLES, StatusPills } from "./pills";

export const PANEL_STYLES = `
  :root { color-scheme: light dark; }
  .aiui-panel { font: 13px/1.45 system-ui, sans-serif; padding: 12px; max-width: 460px; }
  .aiui-help { margin-top: 10px; border-collapse: collapse; }
  .aiui-help td { padding: 1px 8px 1px 0; }
  /* Preview mode (no open turn): the same rows, dimmed — these keys aren't
     live yet; the note row stays at full strength and says how to get there. */
  .aiui-help[data-preview] tr:not(.aiui-help-note) { opacity: 0.45; }
  .aiui-help kbd { border: 1px solid color-mix(in srgb, currentColor 30%, transparent);
    border-radius: 4px; padding: 0 5px; font: 11px ui-monospace, monospace; }
  .aiui-blip { margin-top: 6px; color: #dc2626; font-size: 12px; }
`
  .concat(BAR_STYLES)
  .concat(PILLS_STYLES)
  .concat(CONFIG_STRIP_STYLES);

export interface PanelProps {
  client: IntentClient;
  /** Called once with the blip sink (blips are UI-local display state). */
  registerBlipSink?: (sink: (key: string) => void) => void;
  /** The live mic level 0..1 (talk.level) — renders the REC meter while talking. */
  micLevel?: () => number;
  /** The lint lifecycle (lanes.linterPulse) — the pulse dot by the linter select. */
  linterPulse?: () => LinterPulseView;
  /** The converse (debug) lint-now button (lanes.lintNow). */
  lintControl?: LintControlHandlers;
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

  // The tap-flash runtime, created ONCE and shared by the command bar and the
  // config strip (one flash closure, not one per strip).
  const capRuntime = createCapRuntime(client.dispatch);

  /** Help ALWAYS shows the real keymap. Outside a turn the layer is inactive
   * (its keys genuinely do nothing yet), so the rows come from a PREVIEW of
   * the turn state — same table, dimmed, under one header saying how to get
   * there. The displayed keymap stays the working keymap: one source
   * (hintsFor); the phase decides presentation, never existence. */
  const helpView = createMemo(() => {
    const state = client.state();
    const live = state.phase === "turn";
    return { live, rows: live ? hintsFor(state) : hintsFor({ ...state, phase: "turn" }) };
  });

  return (
    <div class="aiui-panel" data-testid="aiui-panel">
      <style>{PANEL_STYLES}</style>
      {/* The mode tree, depth-first: a parent sits right before its children,
          and a lit parent's subtree is bracketed by a faint depth-shaded
          group — the vertical rules are the only hint that a linear row of
          caps is actually a hierarchy. */}
      <CommandBar items={() => client.bar()} runtime={capRuntime} />

      <Show when={client.state().help === true}>
        <table
          class="aiui-help"
          data-testid="keymap-help"
          data-preview={helpView().live ? undefined : ""}
        >
          <tbody>
            <Show when={!helpView().live}>
              <tr class="aiui-help-note" data-testid="keymap-help-note">
                <td>
                  <kbd>activate</kbd>
                </td>
                <td />
                <td>
                  these keys live in-turn — the activation shortcut (or the caps above) opens one
                </td>
              </tr>
            </Show>
            <For each={helpView().rows}>
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

      <Show when={blip()}>
        {(key) => (
          <div class="aiui-blip" data-testid="blip">
            swallowed: {key()}
          </div>
        )}
      </Show>

      <ConfigStrip
        client={client}
        runtime={capRuntime}
        linterPulse={props.linterPulse}
        lintControl={props.lintControl}
      />

      {/* Pills BELOW the config strip (owner, 2026-07-14: bar → config → pills). */}
      <StatusPills client={client} micLevel={props.micLevel} />
    </div>
  );
}
