/**
 * config-strip.tsx — the standing-settings strip: the config bar's widgets
 * (stt · linter · log · shot flash), always visible, rendered through the
 * shared BarItemView, plus the lint lifecycle dot injected right after the
 * linter select. The dot is a PERMANENT fixed-width box — phases swap its
 * glyph/color, never its layout — mirroring the sidecar's machine
 * (linter-pulse.ts).
 */

import { Repeat, Show } from "solid-js";
import type { IntentClient } from "../client";
import type { LinterPulseView } from "../linter-pulse";
import { BarItemView, type CapRuntime } from "./bar";

export const CONFIG_STRIP_STYLES = `
  .aiui-config { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 8px; padding-top: 6px;
    border-top: 1px solid color-mix(in srgb, currentColor 15%, transparent); }
  /* The lint lifecycle dot: a PERMANENT fixed box (1.4em) — phases swap glyph
     and color only, so the strip never relayouts. Phases mirror the sidecar's
     machine (linter-pulse.ts). */
  .aiui-linter-pulse { display: inline-block; width: 1.4em; text-align: center;
    font-size: 12px; line-height: 1; align-self: center; opacity: 0.35;
    margin-left: -6px; user-select: none; }
  .aiui-linter-pulse[data-phase="listening"] { opacity: 1; color: #16a34a; }
  .aiui-linter-pulse[data-phase="thinking"] { opacity: 1; color: #7c3aed;
    animation: aiui-pulse-breathe 0.9s ease-in-out infinite; }
  .aiui-linter-pulse[data-phase="tool"] { opacity: 1; color: #7c3aed;
    animation: aiui-pulse-breathe 0.9s ease-in-out infinite; }
  .aiui-linter-pulse[data-phase="noted"] { opacity: 1; }
  .aiui-linter-pulse[data-phase="stale"] { opacity: 1; color: #dc2626; }
  @keyframes aiui-pulse-breathe { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
  /* The converse (debug) lint-now button beside the pulse dot. Same 12px
     voice as the strip; disabled = the phase can't use it. (The stop button
     was removed 2026-07-19: voice barge-in cancels an in-flight reply, and
     the select's off value is the off switch.) */
  .aiui-lint-btn { font-size: 11px; line-height: 1.4; align-self: center;
    padding: 0 6px; border-radius: 4px; cursor: pointer;
    border: 1px solid color-mix(in srgb, currentColor 30%, transparent);
    background: transparent; color: inherit; }
  .aiui-lint-btn:disabled { opacity: 0.35; cursor: default; }
`;

/** The pulse dot's glyph per phase — every glyph fits the same fixed box. */
const PULSE_GLYPHS: Record<LinterPulseView["phase"], string> = {
  off: "·",
  idle: "·",
  listening: "●",
  thinking: "◍",
  tool: "⚒",
  noted: "💡",
  stale: "⚠",
};

/** The converse (debug) lint-now handler (lanes.lintNow). */
export interface LintControlHandlers {
  now(): void;
}

/** Which pulse phases the lint-now button is live in: it needs an open
 *  (accumulating) window to judge. */
const LINT_NOW_PHASES: ReadonlySet<LinterPulseView["phase"]> = new Set(["listening"]);

/** The config strip: control-bound widgets, always visible, with the pulse dot. */
export function ConfigStrip(props: {
  client: IntentClient;
  runtime: CapRuntime;
  linterPulse?: () => LinterPulseView;
  /** The converse (debug) pair — absent hosts (no lanes) render no buttons. */
  lintControl?: LintControlHandlers;
}) {
  const { client } = props;
  return (
    <div class="aiui-config" data-testid="config-strip">
      <Repeat count={client.configStrip().length}>
        {(rowIndex) => {
          const row = () => client.configStrip()[rowIndex];
          return (
            <Repeat count={row()?.items.length ?? 0}>
              {(itemIndex) => {
                const item = () => row()?.items[itemIndex];
                const isLinter = () => {
                  const it = item();
                  return it?.kind === "widget" && it.control === "linter";
                };
                return (
                  <>
                    <BarItemView item={item} runtime={props.runtime} />
                    {/* The lint lifecycle dot, INSIDE the strip right after
                        the linter select. A permanent fixed-width span —
                        state changes swap its glyph/color, never its box, so
                        nothing relayouts (owner, 2026-07-16). */}
                    <Show when={props.linterPulse !== undefined && isLinter()}>
                      <span
                        class="aiui-linter-pulse"
                        data-testid="linter-pulse"
                        data-phase={props.linterPulse?.().phase}
                        title={props.linterPulse?.().detail}
                      >
                        {PULSE_GLYPHS[props.linterPulse?.().phase ?? "off"]}
                      </span>
                      {/* The converse (debug) lint-now: end the lint turn
                          at the BUTTON. Enabled off the pulse phase — the
                          mirror of what the sidecar would accept
                          (capture-bus-and-consumers.md §6 Phase 1). To abort
                          a reply instead, talk over it (barge-in). */}
                      <Show when={props.lintControl !== undefined}>
                        <button
                          type="button"
                          class="aiui-lint-btn"
                          data-testid="lint-now"
                          title="end the lint turn now (then the linter turns off)"
                          disabled={!LINT_NOW_PHASES.has(props.linterPulse?.().phase ?? "off")}
                          onClick={() => props.lintControl?.now()}
                        >
                          lint now
                        </button>
                      </Show>
                    </Show>
                  </>
                );
              }}
            </Repeat>
          );
        }}
      </Repeat>
    </div>
  );
}
