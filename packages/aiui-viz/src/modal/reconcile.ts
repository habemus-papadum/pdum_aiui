/**
 * The reconciler pass (modal-interaction-lessons §4.5, rule §3.5).
 *
 * Render is reconciliation: every mode-dependent surface (an overlay veil,
 * pointer-events routing, a cursor, a ring color) is asserted FROM state on
 * every event, never toggled imperatively at transitions. The durable fix for
 * the retired dev overlay's stranded-veil bug was not better transition
 * bookkeeping but a
 * per-event assertion — "not armed+ink ⇒ veil hidden" — so a missed
 * transition costs one frame, not a wedged UI.
 *
 * A surface rule is a named, idempotent function of the current mode. The
 * reconciler runs them all, isolating failures: one throwing surface must not
 * stop the others — the reconciler IS the safety net, and a safety net that
 * dies on the first hole isn't one. Failures are reported (console.error by
 * default) rather than swallowed, because a silently failing invariant is the
 * bug class this exists to kill.
 *
 * This is also the best property test of a modal surface: for every reachable
 * state, surfaces match the table.
 */

export interface SurfaceRule<M extends string> {
  /** Names show up in error reports: "surface 'shot-veil' threw". */
  name: string;
  /** Assert this surface's invariant for `mode`. Must be idempotent. */
  apply(mode: M): void;
}

export interface ReconcilerOptions {
  /** Failure sink; defaults to console.error. */
  onError?: (surface: string, error: unknown) => void;
}

/**
 * Build the pass. Call the returned function after EVERY event/dispatch —
 * unconditionally, not just on transitions you remembered to handle.
 */
export function createReconciler<M extends string>(
  surfaces: readonly SurfaceRule<M>[],
  options: ReconcilerOptions = {},
): (mode: M) => void {
  const report =
    options.onError ??
    ((surface: string, error: unknown) => {
      console.error(`[aiui-viz/modal] surface "${surface}" threw during reconcile`, error);
    });
  return (mode: M) => {
    for (const surface of surfaces) {
      try {
        surface.apply(mode);
      } catch (error) {
        report(surface.name, error);
      }
    }
  };
}
