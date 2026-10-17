/**
 * Guarded async effects — one async operation under three disciplines that
 * are structural here so no call site can forget them (the lessons behind
 * them are recorded in docs/mode-engine.md):
 *
 *  - **Completion-time revalidation.** Launch-time checks are worthless for
 *    slow effects: a screenshot that resolves after the share picker (seconds
 *    later) can land in a turn that was already sent. `stillValid` is
 *    re-checked when the result arrives; a stale result is returned as
 *    `"stale"` so the caller drops it instead of folding it in.
 *  - **A ceiling.** Timeouts are part of the effect, not the caller's
 *    problem — no mode may wedge on a promise (the "Enter waits for a
 *    transcript that will never come" class). The ceiling aborts the signal
 *    and resolves `"timeout"`.
 *  - **An outer abort.** The caller may hand in its own `signal` (a claim
 *    superseded while acquiring); its abort is forwarded to the run's signal
 *    at once, and a run that then fails resolves `"aborted"` — not a fault,
 *    the caller asked. A run that lands anyway is judged by `stillValid`.
 *
 * `guardedEffect` never rejects; every outcome is data the caller folds.
 */

export type GuardedOutcome<T> =
  | { status: "ok"; value: T }
  /** Completed, but `stillValid()` said the world moved on — drop the value. */
  | { status: "stale"; value: T }
  | { status: "timeout" }
  /** The caller's outer `signal` aborted the run before it landed. */
  | { status: "aborted" }
  | { status: "error"; error: unknown };

export interface GuardOptions {
  /** Hard ceiling in ms; omit for effects with their own bounded transport. */
  ceilingMs?: number;
  /**
   * Re-checked at completion time (NOT launch time). Return false when the
   * mode/turn the effect was launched for is gone.
   */
  stillValid?: () => boolean;
  /**
   * An outer abort signal: its abort is forwarded to the run's signal (with
   * the same reason) the moment it fires, before any ceiling.
   */
  signal?: AbortSignal;
}

export async function guardedEffect<T>(
  options: GuardOptions,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<GuardedOutcome<T>> {
  const controller = new AbortController();
  const outer = options.signal;
  const forward = () => controller.abort(outer?.reason);
  if (outer !== undefined) {
    if (outer.aborted) {
      forward();
    } else {
      outer.addEventListener("abort", forward, { once: true });
    }
  }
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ceiling =
    options.ceilingMs === undefined
      ? undefined
      : new Promise<GuardedOutcome<T>>((resolve) => {
          timer = setTimeout(() => {
            timedOut = true;
            controller.abort();
            resolve({ status: "timeout" });
          }, options.ceilingMs);
        });
  const attempt = (async (): Promise<GuardedOutcome<T>> => {
    try {
      const value = await run(controller.signal);
      if (options.stillValid && !options.stillValid()) {
        return { status: "stale", value };
      }
      return { status: "ok", value };
    } catch (error) {
      // The abort we caused is the timeout outcome, not an error; the abort
      // the caller caused is theirs to expect.
      if (timedOut) {
        return { status: "timeout" };
      }
      if (outer?.aborted) {
        return { status: "aborted" };
      }
      return { status: "error", error };
    }
  })();
  try {
    return await (ceiling ? Promise.race([ceiling, attempt]) : attempt);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    outer?.removeEventListener("abort", forward);
  }
}
