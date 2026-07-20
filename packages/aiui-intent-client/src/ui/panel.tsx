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

import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import type { IntentClient } from "../client";
import { hintsFor } from "../keys";
import type { LinterPulseView } from "../linter-pulse";
import { BAR_STYLES, CommandBar, createCapRuntime } from "./bar";
import { CONFIG_STRIP_STYLES, ConfigStrip, type LintControlHandlers } from "./config-strip";
import { PILLS_STYLES, StatusPills } from "./pills";

export const PANEL_STYLES = `
  :root { color-scheme: light dark; }
  .aiui-panel { font: 13px/1.45 system-ui, sans-serif; padding: 12px; max-width: 460px;
    position: relative; /* the abandon-confirm scrim covers the panel, not the page */ }
  .aiui-help { margin-top: 10px; border-collapse: collapse; }
  .aiui-help td { padding: 1px 8px 1px 0; }
  /* Preview mode (no open turn): the same rows, dimmed — these keys aren't
     live yet; the note row stays at full strength and says how to get there. */
  .aiui-help[data-preview] tr:not(.aiui-help-note) { opacity: 0.45; }
  .aiui-help kbd { border: 1px solid color-mix(in srgb, currentColor 30%, transparent);
    border-radius: 4px; padding: 0 5px; font: 11px ui-monospace, monospace; }
  .aiui-blip { margin-top: 6px; color: #dc2626; font-size: 12px; }
  /* Abandon-confirm: a panel-local scrim + card. Covers the panel (not the
     page); the turn stays open behind it until the user chooses. */
  .aiui-confirm-scrim { position: absolute; inset: 0; z-index: 20;
    display: flex; align-items: center; justify-content: center; padding: 16px;
    background: color-mix(in srgb, currentColor 32%, transparent); }
  .aiui-confirm { max-width: 340px; border-radius: 10px; padding: 14px 16px;
    background: Canvas; color: CanvasText; border: 1px solid color-mix(in srgb, currentColor 25%, transparent);
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.45); font-size: 13px; line-height: 1.5; }
  .aiui-confirm h2 { margin: 0 0 6px; font-size: 14px; }
  .aiui-confirm p { margin: 0 0 6px; }
  .aiui-confirm .aiui-confirm-keys { opacity: 0.7; font-size: 12px; }
  .aiui-confirm kbd { border: 1px solid color-mix(in srgb, currentColor 30%, transparent);
    border-radius: 4px; padding: 0 5px; font: 11px ui-monospace, monospace; }
  .aiui-confirm-row { display: flex; gap: 8px; justify-content: flex-end; margin-top: 12px; }
  .aiui-confirm-row button { font: inherit; padding: 5px 12px; border-radius: 6px; cursor: pointer;
    border: 1px solid color-mix(in srgb, currentColor 30%, transparent); background: transparent; color: inherit; }
  .aiui-confirm-row button.danger { border-color: #dc2626; color: #dc2626; }
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
  /**
   * Live check (lanes.turnHasContent) for the abandon-confirm gate: does the
   * open turn hold anything worth lowering? Undefined without a channel — no
   * lanes means no accumulated content, so the gate is simply inert.
   */
  turnHasContent?: () => boolean;
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

  // The abandon-confirm gate (owner, 2026-07-20). The turn cap is a lit toggle
  // that abandons an open turn in ONE click; a stray tap (meant for Enter)
  // silently discards whatever you'd built. So when the turn holds content,
  // that one tap raises a confirm instead of abandoning. Only the CAP is gated:
  // Esc and `d` stay immediate (the dialog itself teaches Esc as the deliberate
  // exit), and programmatic routes — agent control() writes, the activation
  // gesture, tests — never tap the cap, so they never see the dialog.
  const [confirming, setConfirming] = createSignal(false, { ownedWrite: true });
  const inOpenTurn = (): boolean => {
    const phase = client.state().phase;
    return phase === "turn" || phase === "tweak";
  };
  const closeConfirm = (): void => {
    setConfirming(false);
  };
  const abandonTurn = (): void => {
    setConfirming(false);
    // Re-check: the turn may have closed while the dialog sat open (a send on
    // the control rail). Dispatching "turn" from armed would OPEN one — guard.
    if (inOpenTurn()) {
      client.dispatch("turn");
    }
  };

  // The tap-flash runtime, created ONCE and shared by the command bar and the
  // config strip (one flash closure, not one per strip). Its intercept guard is
  // the gate: claim the turn-cap tap that would abandon a content-ful turn.
  const capRuntime = createCapRuntime(client.dispatch, (command) => {
    if (command === "turn" && inOpenTurn() && props.turnHasContent?.() === true) {
      setConfirming(true);
      return true;
    }
    return false;
  });

  // While the dialog is open it OWNS the keyboard. This fires in window-capture
  // — BEFORE the panel document's own capture grammar (shell.tsx), which would
  // otherwise read Esc as "step out" and cancel the very turn we're protecting.
  // Esc and Enter both take the SAFE exit (keep the turn); only a click on the
  // danger button abandons. Every other key is swallowed so nothing leaks to
  // the machine behind the scrim.
  const onConfirmKey = (event: KeyboardEvent): void => {
    if (!confirming()) {
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.key === "Escape" || event.key === "Enter") {
      closeConfirm();
    }
  };
  if (typeof window !== "undefined") {
    window.addEventListener("keydown", onConfirmKey, true);
    onCleanup(() => window.removeEventListener("keydown", onConfirmKey, true));
  }

  // Defensive: if the turn closes underneath an open dialog (an external send),
  // the prompt is gone anyway — drop the now-meaningless confirm.
  createEffect(
    () => confirming() && !inOpenTurn(),
    (stale) => {
      if (stale) {
        setConfirming(false);
      }
    },
  );

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
                  <kbd>turn</kbd>
                </td>
                <td />
                <td>these keys live in-turn — the turn cap above opens one</td>
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

      {/* Abandon-confirm: raised only when a turn-cap tap would discard a
          content-ful turn. Keys are trapped in window-capture above (Esc/Enter
          keep the turn); the scrim covers the panel so only a deliberate click
          on the danger button abandons. */}
      <Show when={confirming()}>
        <div class="aiui-confirm-scrim" data-testid="abandon-confirm" role="presentation">
          <div
            class="aiui-confirm"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="aiui-confirm-title"
          >
            <h2 id="aiui-confirm-title">Abandon this turn?</h2>
            <p>You'll lose everything you've built up in it.</p>
            <p class="aiui-confirm-keys">
              <kbd>Enter</kbd> sends the turn · <kbd>Esc</kbd> exits it · or keep editing.
            </p>
            <div class="aiui-confirm-row">
              <button type="button" data-testid="abandon-keep" onClick={closeConfirm}>
                Keep editing
              </button>
              <button
                type="button"
                class="danger"
                data-testid="abandon-confirm-btn"
                onClick={abandonTurn}
              >
                Abandon turn
              </button>
            </div>
          </div>
        </div>
      </Show>
    </div>
  );
}
