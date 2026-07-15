/**
 * bar.ts — the command bar as a projection of the mode-engine spec
 * (docs/proposals/intent-client/01-mode-engine.md §3.5, extended per owner
 * review 2026-07-13).
 *
 * The bar is a **tree presented linearly**: root caps are the standing
 * surface (arm · step out · help); a cap that is SHOWN and LIT reveals its
 * children. Two projections of that one tree:
 *
 *  - {@link barTree} — DEPTH-FIRST (pre-order): a parent sits immediately
 *    before its own revealed subtree, so the host renders a linear row of
 *    caps where a lit parent and its descendants are bracketed as one shaded
 *    group. THIS is what the command bar draws (owner, 2026-07-15).
 *  - {@link barModel} — breadth-first depth rows (one row per tier). The flat
 *    config strip still reads this; its single tier makes the two identical.
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
  /**
   * A press-and-HOLD cap (push-to-talk): the host binds pointer down/up to
   * these commands instead of click. `command` stays the identity/enabled
   * probe (usually the same as `hold.down`).
   */
  hold?: { down: string; up: string };
  /** Display row. RULE: the label must not vary with state (lit does). */
  hint: KeyHint | ((inputs: BarInputs<Ctx>) => KeyHint | undefined);
  /** The cap renders highlighted (its mode/flag is engaged). */
  litWhen?: (inputs: BarInputs<Ctx>) => boolean;
  /** Rare override; default is the engine's derived `canDispatch`. */
  enabledWhen?: (inputs: BarInputs<Ctx>) => boolean;
  /** The cap exists at all in this state (default: always). */
  showWhen?: (inputs: BarInputs<Ctx>) => boolean;
  /**
   * This cap belongs to the REMOTE subset — carried onto the projected view so a
   * remote-bar host can filter its projection to what a bar-only remote (the
   * iPad) may see and tap. Static per node (not a predicate): membership is a
   * property of the affordance, not the moment. Absent ⇒ desktop-only.
   */
  remote?: boolean;
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
  hold?: { down: string; up: string };
  hint: KeyHint;
  lit: boolean;
  enabled: boolean;
  /** Mirrors {@link CapSpec.remote}: this cap is in the remote subset. Only
   * emitted when the node declared it, so desktop-only caps stay field-free
   * (keeps `barModel` snapshots and the WireCap drift guard unchanged). */
  remote?: boolean;
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
 * One node of the bar as a PRE-ORDER (depth-first) tree: the item itself plus
 * the descendants revealed beneath it right now. `children` is non-empty only
 * for a cap that is shown, lit, and actually declares children — so a node
 * with children is exactly a live grouping the renderer can bracket (thin
 * left/right borders, a depth-shaded tint), and the parent sits immediately
 * before its own children in the flow, not on a separate tier.
 */
export interface BarTreeNode {
  item: BarItem;
  /** Nesting level from the root (0 = root); drives the grouping shade. */
  depth: number;
  /** The revealed subtree, in declaration order (empty for a leaf). */
  children: BarTreeNode[];
}

/**
 * Project the bar tree DEPTH-FIRST: each shown node in declaration order, its
 * revealed children nested directly under it (pre-order). Same admission rule
 * as {@link barModel} — a child tier appears only while its parent cap is
 * shown AND lit — but the shape keeps a parent adjacent to its descendants so
 * the UI can draw them as one bracketed group instead of splitting the tree
 * across depth rows. This is what the command bar renders; {@link barModel}
 * (breadth-first depth rows) stays for the flat config strip.
 */
export function barTree<Ctx>(
  nodes: readonly BarNode<Ctx>[],
  inputs: BarInputs<Ctx>,
  depth = 0,
): BarTreeNode[] {
  const out: BarTreeNode[] = [];
  for (const node of nodes) {
    if (node.showWhen !== undefined && !node.showWhen(inputs)) {
      continue;
    }
    if (node.kind === "widget") {
      out.push({
        item: {
          kind: "widget",
          control: node.control,
          widget: node.widget,
          label: node.label,
          enabled: node.enabledWhen?.(inputs) ?? true,
        },
        depth,
        children: [],
      });
      continue;
    }
    const hint = typeof node.hint === "function" ? node.hint(inputs) : node.hint;
    if (hint === undefined) {
      continue;
    }
    const lit = node.litWhen?.(inputs) ?? false;
    const enabled =
      node.enabledWhen?.(inputs) ??
      (node.hold !== undefined
        ? inputs.canDispatch(node.hold.down) || inputs.canDispatch(node.hold.up)
        : inputs.canDispatch(node.command, node.payload));
    out.push({
      item: {
        kind: "cap",
        command: node.command,
        ...(node.payload !== undefined ? { payload: node.payload } : {}),
        ...(node.hold !== undefined ? { hold: node.hold } : {}),
        hint,
        lit,
        enabled,
        ...(node.remote !== undefined ? { remote: node.remote } : {}),
      },
      depth,
      children: lit && node.children !== undefined ? barTree(node.children, inputs, depth + 1) : [],
    });
  }
  return out;
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
      // A HOLD cap stays enabled while EITHER half of its gesture applies:
      // mid-press the down command reads unavailable, but disabling the
      // button then would swallow the pointerup and wedge the hold.
      const enabled =
        node.enabledWhen?.(inputs) ??
        (node.hold !== undefined
          ? inputs.canDispatch(node.hold.down) || inputs.canDispatch(node.hold.up)
          : inputs.canDispatch(node.command, node.payload));
      items.push({
        kind: "cap",
        command: node.command,
        ...(node.payload !== undefined ? { payload: node.payload } : {}),
        ...(node.hold !== undefined ? { hold: node.hold } : {}),
        hint,
        lit,
        enabled,
        ...(node.remote !== undefined ? { remote: node.remote } : {}),
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
