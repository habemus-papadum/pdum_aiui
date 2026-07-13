/**
 * bar.ts — the command bar as a projection of the mode-engine spec
 * (docs/proposals/intent-client/01-mode-engine.md §3.5, extended per owner
 * review 2026-07-13).
 *
 * The bar is a **tree presented linearly**: root caps are the standing
 * surface (arm · step out · help); a cap that is SHOWN and LIT reveals its
 * children, and the projection flattens the tree into depth rows — the UI
 * renders one linear row per depth, so engaging hands-free surfaces its mute
 * sibling-row, engaging video surfaces cadence and rate, without anything
 * jumping inside an existing row.
 *
 * Two rules the projection enforces by construction:
 *
 *  - **Labels are stable.** A cap's text never changes with state — the lit
 *    highlight carries "engaged"; a label swap is a relayout and a re-read.
 *    (`hint` can still be a function for claims-status TOOLTIPS, but treat
 *    the label as fixed.)
 *  - **Enabled is derived.** A cap's default enablement asks the engine
 *    `canDispatch(command)` — "would this do anything right now?" — which
 *    dry-runs the pure reducer. Disarmed ⇒ ink/tweak/send disable
 *    mechanically; nothing is hand-written per cap. Verbs gate via the
 *    spec's `available` map; `enabledWhen` remains as a rare override.
 *
 * Nodes are caps (dispatch a command) or **widgets** (a slider/select/toggle
 * bound to a named control — the agent-visible ports). The kit stays
 * framework-free: widgets travel as descriptors; the host renderer binds
 * them (`controlByName`) and draws them.
 */

import type { ClaimStatus } from "./claims";
import type { EngineState } from "./engine";
import type { KeyHint } from "./keys";

/** Everything a bar predicate may look at. */
export interface BarInputs<Ctx> {
  state: EngineState;
  ctx: Ctx;
  /** Claim statuses, for status-aware tooltips (● warming…). */
  claims: Readonly<Record<string, ClaimStatus>>;
  /** The engine's derived availability (ModeEngine.canDispatch). */
  canDispatch(command: string, payload?: unknown): boolean;
}

export interface CapSpec<Ctx> {
  kind?: "cap";
  /** The command a tap dispatches — the same resolver path as the key. */
  command: string;
  /** Payload for the dispatch, when the command takes one. */
  payload?: unknown;
  /** Display row. RULE: the label must not vary with state (lit does). */
  hint: KeyHint | ((inputs: BarInputs<Ctx>) => KeyHint | undefined);
  /** The cap renders highlighted (its mode/flag is engaged). */
  litWhen?: (inputs: BarInputs<Ctx>) => boolean;
  /** Rare override; default is the engine's derived `canDispatch`. */
  enabledWhen?: (inputs: BarInputs<Ctx>) => boolean;
  /** The cap exists at all in this state (default: always). */
  showWhen?: (inputs: BarInputs<Ctx>) => boolean;
  /** Revealed one depth down while this cap is shown AND lit. */
  children?: readonly BarNode<Ctx>[];
}

/** A control-bound widget in the bar (slider, select, toggle). */
export interface WidgetSpec<Ctx> {
  kind: "widget";
  /** The registered control's name — the host renderer binds it. */
  control: string;
  widget: "slider" | "select" | "toggle";
  /** Stable display label. */
  label: string;
  showWhen?: (inputs: BarInputs<Ctx>) => boolean;
  enabledWhen?: (inputs: BarInputs<Ctx>) => boolean;
}

export type BarNode<Ctx> = CapSpec<Ctx> | WidgetSpec<Ctx>;

/** One renderable cap. */
export interface CapView {
  kind: "cap";
  command: string;
  payload?: unknown;
  hint: KeyHint;
  lit: boolean;
  enabled: boolean;
}

/** One renderable widget. */
export interface WidgetView {
  kind: "widget";
  control: string;
  widget: "slider" | "select" | "toggle";
  label: string;
  enabled: boolean;
}

export type BarItem = CapView | WidgetView;

/** One depth tier of the flattened tree, in declaration order. */
export interface BarRow {
  depth: number;
  items: BarItem[];
}

/**
 * Project the bar tree for the current inputs: depth rows, declaration
 * order, children admitted while their parent cap is shown and lit. Empty
 * rows are dropped.
 */
export function barModel<Ctx>(nodes: readonly BarNode<Ctx>[], inputs: BarInputs<Ctx>): BarRow[] {
  const rows: BarRow[] = [];
  let level: Array<BarNode<Ctx>> = [...nodes];
  let depth = 0;
  while (level.length > 0) {
    const items: BarItem[] = [];
    const next: Array<BarNode<Ctx>> = [];
    for (const node of level) {
      if (node.showWhen !== undefined && !node.showWhen(inputs)) {
        continue;
      }
      if (node.kind === "widget") {
        items.push({
          kind: "widget",
          control: node.control,
          widget: node.widget,
          label: node.label,
          enabled: node.enabledWhen?.(inputs) ?? true,
        });
        continue;
      }
      const hint = typeof node.hint === "function" ? node.hint(inputs) : node.hint;
      if (hint === undefined) {
        continue;
      }
      const lit = node.litWhen?.(inputs) ?? false;
      items.push({
        kind: "cap",
        command: node.command,
        ...(node.payload !== undefined ? { payload: node.payload } : {}),
        hint,
        lit,
        enabled: node.enabledWhen?.(inputs) ?? inputs.canDispatch(node.command, node.payload),
      });
      if (lit && node.children !== undefined) {
        next.push(...node.children);
      }
    }
    if (items.length > 0) {
      rows.push({ depth, items });
    }
    level = next;
    depth += 1;
  }
  return rows;
}
