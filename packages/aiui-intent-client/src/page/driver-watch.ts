/**
 * driver-watch.ts — the page side of DRIVER LIVENESS (owner, 2026-07-15).
 *
 * A page's assertions — key capture, the ring, an engaged ink/pencil surface,
 * an armed region drag — belong to a DRIVER: the panel client that asked for
 * them. When that driver dies without releasing them (side panel closed
 * mid-turn, the panel tab killed, the extension reloaded under `ext:watch`),
 * the page is left eating keys with nowhere to send them, and nobody alive
 * can clean it up. So the page cleans itself.
 *
 * The driver proves it lives two ways: every assertion-carrying request
 * counts as proof of life, and an explicit `heartbeat` capability arrives on
 * a short cadence (transport.ts HEARTBEAT_MS) carrying the driver's per-boot
 * SESSION id. Two verdicts follow:
 *
 *  - silence past the timeout → {@link DriverWatchOptions.onGone} — a HARD
 *    cleanup: the residue (strokes included) belongs to a dead session;
 *  - a beat naming a DIFFERENT session → {@link DriverWatchOptions.onChanged}
 *    — a SOFT reset: a new/reloaded panel took over. Assertions drop, the
 *    user's strokes SURVIVE (the page-script `adopt` rule: a reloaded panel's
 *    turn recovery must find its ink), and the new client re-asserts what it
 *    wants through the ordinary claim paths — the "reboot" is free.
 *
 * The session id is also where a multiple-drivers detector would hang
 * (alternating ids on one page) — noted, deliberately not built.
 *
 * Used by the MV3 content script. The CDP page-script, which may import
 * nothing at runtime, carries an INLINE TWIN of this logic — keep them
 * aligned (cdp/page-script.ts, "driver liveness").
 */

export interface DriverWatchOptions {
  /** Beat silence longer than this = the driver is gone. */
  timeoutMs: number;
  /** Beats stopped: clean the dead driver's residue, strokes included. */
  onGone(): void;
  /** A beat named a NEW session: drop the old driver's assertions only. */
  onChanged(): void;
}

export interface DriverWatch {
  /** A request arrived — the driver lives. Heartbeats also carry `session`. */
  alive(session?: string): void;
  dispose(): void;
}

export function createDriverWatch(options: DriverWatchOptions): DriverWatch {
  let session: string | undefined;
  let last = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  const stop = (): void => {
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };
  return {
    alive: (beatSession) => {
      if (beatSession !== undefined) {
        if (session !== undefined && session !== beatSession) {
          options.onChanged();
        }
        session = beatSession;
      }
      last = Date.now();
      if (timer === undefined) {
        // The check runs at a fraction of the timeout so death is noticed
        // promptly; it stops with the verdict and re-arms on the next sign of
        // life, so an idle page (no driver ever) spends nothing.
        const checkMs = Math.max(250, Math.floor(options.timeoutMs / 3));
        let lastCheck = Date.now();
        timer = setInterval(() => {
          const now = Date.now();
          const stalled = now - lastCheck > checkMs * 2;
          lastCheck = now;
          if (stalled) {
            // The PAGE stalled (GC, a debugger pause, a heavy frame) — beats
            // and this check froze together, so `last` is stale through no
            // fault of the driver's. Give the queued beats one round to land
            // before silence convicts (matters at the tightened timeout).
            return;
          }
          if (now - last > options.timeoutMs) {
            stop();
            session = undefined;
            options.onGone();
          }
        }, checkMs);
      }
    },
    dispose: stop,
  };
}
