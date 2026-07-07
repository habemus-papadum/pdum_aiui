/**
 * Focus as tracked state (modal-interaction-lessons §4.6).
 *
 * A modal editor that must decide "where does this dictated text fold in?"
 * cannot ask the DOM: `document.activeElement` lies during transitions —
 * focus steals (permission pickers, cmd-tab), blur-before-click ordering, and
 * shadow retargeting all make the query answer "wherever focus happens to be
 * mid-flight", not "where the user is working". So the surface records its
 * own notion of focus as plain state, updated from its focus/click handlers,
 * and decision code reads *that*.
 *
 * Deliberately tiny — the value is naming the pattern so the DOM query never
 * creeps back into decision code. Tab order inside a modal editor is the
 * app's explicit hop (two stops, wrap around), not native tab flow.
 */

export interface FocusTracker<F extends string> {
  /** The last place the user deliberately put focus. */
  last(): F;
  /** Record a deliberate focus move (call from focus/click handlers). */
  set(focus: F): void;
}

export function createFocusTracker<F extends string>(initial: F): FocusTracker<F> {
  let current = initial;
  return {
    last: () => current,
    set: (focus: F) => {
      current = focus;
    },
  };
}
