/**
 * Best-effort auto-dismiss of Claude's custom-channel acknowledgement prompt.
 *
 * When `aiui claude` opts a session into our development channel
 * (`--dangerously-load-development-channels`), Claude shows a prompt at startup
 * asking the user to confirm they're using it for local development. It's the
 * same keypress every time, so we press Enter for them.
 *
 * How: `aiui` and the `claude` it spawns share one controlling terminal. A
 * short-lived `perl` helper opens that terminal (`/dev/tty`) and pushes a
 * carriage return into its input queue via the TIOCSTI ioctl — exactly as if
 * the user had typed Enter. Claude, the foreground reader, consumes it. We
 * target the terminal, not Claude's PID, which is both simpler and more robust.
 *
 * Deliberately best-effort and silent — in every failure the user just presses
 * Enter themselves, so we never surface an error:
 *  - Only macOS and Linux have known TIOCSTI request numbers; elsewhere we skip.
 *  - Modern Linux (≥6.2) disables TIOCSTI by default (`dev.tty.legacy_tiocsti=0`),
 *    so the ioctl returns EPERM — a no-op.
 *  - No `perl` on PATH, no controlling tty, etc. → also a no-op.
 *
 * Safety if the prompt ever goes away (say Claude adds a skip flag): a stray
 * Enter at Claude's empty main input is a no-op submit, so an unneeded nudge
 * does no harm. The attempts are also kept early (before a user could plausibly
 * have dismissed the prompt and started typing a real message) so we don't race
 * their input. Set `AIUI_NO_ENTER_NUDGE=1` to disable entirely.
 */
import { spawn } from "node:child_process";

// TIOCSTI ioctl request number by platform ("push one byte into the tty input
// queue as if typed"). darwin: _IOW('t',114,char) = 0x80017472; linux: 0x5412.
const TIOCSTI_BY_PLATFORM: Partial<Record<NodeJS.Platform, number>> = {
  darwin: 0x80017472,
  linux: 0x5412,
};

// perl one-liner (perl ships with a builtin ioctl(), avoiding a native addon):
// open the controlling terminal and inject a carriage return. `$ARGV[0]` is the
// platform's TIOCSTI number. Any failure — a locked-down kernel, no tty — exits
// quietly. Passed as a single argv entry (no shell), so `\r` needs no escaping
// beyond the JS string literal.
const PERL_INJECT = 'open(my $t,"+<","/dev/tty") or exit 0; my $c="\\r"; ioctl($t,$ARGV[0]+0,$c);';

/** Delays (ms after spawn) at which to attempt the keypress. */
const DEFAULT_DELAYS_MS = [250, 750];

/**
 * Schedule a couple of best-effort Enter keypresses into the controlling
 * terminal to dismiss the channel prompt. Returns immediately; the attempts run
 * on unref'd timers so they never hold the CLI open, and every error is
 * swallowed. Call this only for an interactive session (see the caller).
 */
export function nudgeChannelAck(delaysMs: number[] = DEFAULT_DELAYS_MS): void {
  if (process.env.AIUI_NO_ENTER_NUDGE) {
    return;
  }
  const tiocsti = TIOCSTI_BY_PLATFORM[process.platform];
  if (tiocsti === undefined) {
    return;
  }

  for (const ms of delaysMs) {
    const timer = setTimeout(() => {
      try {
        const child = spawn("perl", ["-e", PERL_INJECT, String(tiocsti)], { stdio: "ignore" });
        child.on("error", () => {}); // no perl on PATH, etc. — ignore
      } catch {
        // ignore — the user can always press Enter themselves
      }
    }, ms);
    timer.unref();
  }
}
