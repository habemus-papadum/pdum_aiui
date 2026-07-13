/**
 * bar.ts — the command bar as a projection of the mode-engine spec
 * (docs/proposals/intent-client/01-mode-engine.md §3.5).
 *
 * The surfaces that historically drifted — caps lit inverted, a bar that
 * never unhid, hints disagreeing with keys — drifted because each was a
 * hand-maintained copy of the same state. Here they are *renders*: the app
 * declares an ordered cap list (command + hint + predicates), and the bar
 * model is recomputed from (state, ctx, claims) per event. A cap executes by
 * dispatching its command — the same entry point as the key, so a click can
 * never drift from what the key does (keys.ts's `tapKey` note, upgraded to
 * a guarantee).
 *
 * `reveals` names mode-scoped sub-widgets (the fps slider while video is
 * constant; the ink-fade slider while ink is on) — the "springing sliders"
 * as declared tenancy rather than imperative mounting.
 *
 * Realm rules: pure data in, pure data out; rendering is the host's job
 * (a Solid component maps CapView[] to buttons in a few lines).
 */

import type { ClaimStatus } from "./claims";
import type { EngineState } from "./engine";
import type { KeyHint } from "./keys";

/** Everything a cap predicate may look at. */
export interface BarInputs<Ctx> {
  state: EngineState;
  ctx: Ctx;
  /** Claim statuses, for caps that show operation status (● warming…). */
  claims: Readonly<Record<string, ClaimStatus>>;
}

export interface CapSpec<Ctx> {
  /** The command a tap dispatches — the same resolver path as the key. */
  command: string;
  /** Payload for the dispatch, when the command takes one. */
  payload?: unknown;
  /** Display row (key cap, label, icon) — static or state-dependent. */
  hint: KeyHint | ((inputs: BarInputs<Ctx>) => KeyHint | undefined);
  /** The cap renders highlighted (the mode/flag it toggles is engaged). */
  litWhen?: (inputs: BarInputs<Ctx>) => boolean;
  /** The cap renders but refuses taps (gating: "needs a bound port"). */
  enabledWhen?: (inputs: BarInputs<Ctx>) => boolean;
  /** The cap exists at all in this state (default: always). */
  showWhen?: (inputs: BarInputs<Ctx>) => boolean;
  /** Mode-scoped sub-widget this cap reveals while lit (host renders it). */
  reveals?: string;
}

/** One renderable cap — plain data for the host's row of buttons. */
export interface CapView {
  command: string;
  payload?: unknown;
  hint: KeyHint;
  lit: boolean;
  enabled: boolean;
  /** Present when the cap is lit and declared a revealed widget. */
  reveals?: string;
}

/**
 * Project the cap list for the current inputs. Hidden caps are absent;
 * order is declaration order (a stable bar — caps never jump around).
 */
export function barModel<Ctx>(caps: readonly CapSpec<Ctx>[], inputs: BarInputs<Ctx>): CapView[] {
  const out: CapView[] = [];
  for (const cap of caps) {
    if (cap.showWhen !== undefined && !cap.showWhen(inputs)) {
      continue;
    }
    const hint = typeof cap.hint === "function" ? cap.hint(inputs) : cap.hint;
    if (hint === undefined) {
      continue;
    }
    const lit = cap.litWhen?.(inputs) ?? false;
    out.push({
      command: cap.command,
      ...(cap.payload !== undefined ? { payload: cap.payload } : {}),
      hint,
      lit,
      enabled: cap.enabledWhen?.(inputs) ?? true,
      ...(lit && cap.reveals !== undefined ? { reveals: cap.reveals } : {}),
    });
  }
  return out;
}
