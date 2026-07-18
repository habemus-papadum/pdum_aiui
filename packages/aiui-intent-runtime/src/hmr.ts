/**
 * The mount-once module's HMR posture, in one place: such a module has NO hot
 * path. `decline()` is a NO-OP in Vite 5+, so invalidate-on-accept is the
 * working way to say so — the update re-propagates as if unaccepted and lands
 * as a full page reload.
 *
 * Callers must keep the `if (import.meta.hot)` guard (and thereby the
 * `import.meta.hot` reference) at their own module scope — Vite wires HMR by
 * statically seeing it there:
 *
 *     if (import.meta.hot) {
 *       invalidateOnHotUpdate(import.meta.hot);
 *     }
 *
 * (`import.meta.hot`'s type comes from hmr-env.d.ts — ambient in THIS
 * package's program only, so consumers that load `vite/client` see no
 * conflicting global.)
 */
export function invalidateOnHotUpdate(hot: {
  accept(cb: (mod?: unknown) => void): void;
  invalidate(message?: string): void;
}): void {
  hot.accept(() => hot.invalidate());
}
