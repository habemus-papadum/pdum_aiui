/**
 * Guarded async effects (modal-interaction-lessons §4.4, rules §3.6 and the
 * timeout half of §3.11).
 *
 * Modal effects — mic acquisition, screen captures, model round-trips — are
 * launched from a command and deliver results as events. Two disciplines are
 * structural here so no call site can forget them:
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
 *
 * `guardedEffect` never rejects; every outcome is data the caller folds.
 */

export type GuardedOutcome<T> =
  | { status: "ok"; value: T }
  /** Completed, but `stillValid()` said the world moved on — drop the value. */
  | { status: "stale"; value: T }
  | { status: "timeout" }
  | { status: "error"; error: unknown };

export interface GuardOptions {
  /** Hard ceiling in ms; omit for effects with their own bounded transport. */
  ceilingMs?: number;
  /**
   * Re-checked at completion time (NOT launch time). Return false when the
   * mode/turn the effect was launched for is gone.
   */
  stillValid?: () => boolean;
}

export async function guardedEffect<T>(
  options: GuardOptions,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<GuardedOutcome<T>> {
  const controller = new AbortController();
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
      // The abort we caused is the timeout outcome, not an error.
      if (timedOut) {
        return { status: "timeout" };
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
  }
}
