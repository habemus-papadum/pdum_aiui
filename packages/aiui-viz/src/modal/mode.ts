/**
 * The mode machine as data (modal-interaction-lessons §4.1).
 *
 * A modal surface's modes, their Esc ladder, and their entry/exit effects are
 * declared in one serializable table instead of scattered booleans and
 * hand-written `stepOut()` logic. The kit deliberately does NOT own the mode
 * value: the app stores it wherever its architecture keeps state (an engine
 * field, a signal, an event in its stream — mode changes SHOULD be events so
 * traces show them and replay reproduces them). What the table gives you
 * mechanically:
 *
 *  - `escTarget` — the escape ladder as a column, not code. The convention it
 *    encodes (hold constant across apps; users build muscle memory): Esc steps
 *    out one level / aborts the current scope, and is never destructive
 *    beyond that scope. Enter commits the current scope and never reaches
 *    through to an outer scope's destructive action.
 *  - `runTransition` — fires the old mode's `onExit` and the new mode's
 *    `onEnter` in order, so entry/exit effects have exactly one home.
 *  - per-mode `cursor` — cursors are part of the mode contract (lessons §3
 *    rule 10); the reconciler asserts them from here rather than surfaces
 *    toggling them ad hoc.
 *  - `blurExits` — whether leaving the window ends the mode (`blurExitTarget`
 *    reads it). Modes whose purpose is a round-trip out of the page (a
 *    jump-to-editor mode) declare it here instead of hand-writing a blur
 *    listener per mode.
 *
 * Keymap *layers* are deliberately not a column: a layer (a config strip, a
 * dialog) claims a few keys while every other key keeps its meaning — that is
 * a different thing from a mode, and conflating them is how "the strip is
 * open" becomes a seventh scattered boolean. See ./keys.ts.
 */

export interface ModeSpec<M extends string> {
  /**
   * Where Esc steps out to from this mode; null when Esc means nothing here
   * (the root mode). One column instead of a hand-written ladder.
   */
  escParent: M | null;
  /** CSS cursor this mode asserts on its owning surface (via the reconciler). */
  cursor?: string;
  /**
   * True when leaving the window ends this mode: on window blur the app
   * should step out (to `escParent`, the same one-level transition Esc
   * takes — {@link blurExitTarget} resolves it). For modes whose purpose is
   * a round-trip out of the page — a jump-to-editor mode — coming back must
   * not resume the mode; a gesture left armed across the excursion is a trap
   * the user has forgotten about.
   */
  blurExits?: boolean;
  /** Entry effect — dispatch commands / start effects; never mutate state directly. */
  onEnter?: (from: M) => void;
  /** Exit effect — release what `onEnter` acquired. Must be idempotent. */
  onExit?: (to: M) => void;
}

export interface ModeTable<M extends string> {
  initial: M;
  modes: Record<M, ModeSpec<M>>;
}

/** The Esc ladder, mechanically: the mode Esc steps out to, or null. */
export function escTarget<M extends string>(table: ModeTable<M>, mode: M): M | null {
  return table.modes[mode].escParent;
}

/**
 * Where window blur steps out to from `mode`, or null when blur means
 * nothing here (the common case). A mode opts in with
 * {@link ModeSpec.blurExits}; the target is its `escParent` — blur is the
 * page-focus sibling of Esc's one-level step-out, never a jump to root.
 * Bind it once per surface: on the window's blur event, transition to the
 * returned mode when non-null (however the app performs transitions — an
 * engine verb, a signal write) instead of hand-writing per-mode listeners.
 */
export function blurExitTarget<M extends string>(table: ModeTable<M>, mode: M): M | null {
  const spec = table.modes[mode];
  return spec.blurExits === true ? spec.escParent : null;
}

/**
 * Fire the exit/enter effects for a mode change and return the new mode.
 * The app owns the mode value; call this exactly once per transition, from
 * the same place the mode-change event is appended to the stream. A
 * self-transition runs nothing.
 */
export function runTransition<M extends string>(table: ModeTable<M>, from: M, to: M): M {
  if (from !== to) {
    table.modes[from].onExit?.(to);
    table.modes[to].onEnter?.(from);
  }
  return to;
}
