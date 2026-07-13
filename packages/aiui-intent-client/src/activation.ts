/**
 * activation.ts — the activation gesture: the repo's first worked example of
 * a correct IMPERATIVE → SOLID boundary (the reference the write-semantics
 * investigation said the codebase never had — its R4).
 *
 * The browser-global activation shortcut (⌘B under chrome.commands in the
 * extension; a plain window listener on the detached page) is NOT a key in
 * the modal keyboard system. It is an imperative event arriving from
 * outside. This function is the boundary crossing, and its shape is the
 * pattern to copy:
 *
 *  - it MINTS the world fact first (the capture grant — the SW's
 *    invocation-gate in the extension, simulated by the page host);
 *  - then it walks the machine with SEQUENTIAL, IDEMPOTENT dispatches of
 *    ordinary commands — the same `arm` / `turn` / `tweak` the bar caps
 *    use, never a privileged side door;
 *  - between steps it re-reads `client.state()` — which is SAFE, and that
 *    is the whole point: dispatch is flush()-committed and machine truth is
 *    a plain frozen object, so the read after a dispatch is never stale.
 *    (Under raw Solid signals this exact shape — write, then branch on a
 *    read-back — was the seven-times-bitten F1 bug. The engine is what
 *    makes the natural way to write this code the correct way.)
 *
 * Decided semantics carried (each a test): activation is idempotent
 * grant-and-open — arms if disarmed, opens a turn if merely armed, resumes
 * from tweak, and in an open turn does nothing. It NEVER cancels.
 */

import type { IntentClient } from "./client";

export function activationGesture(client: IntentClient, grantTab: number | undefined): void {
  if (grantTab !== undefined) {
    client.setContext({ grantedTab: grantTab });
  }
  // The arm gate (channel connected) is the same one the bar shows — the
  // gesture asks the engine instead of duplicating the rule. A refused arm
  // leaves us disarmed and the guards below turn the rest into no-ops.
  if (client.state().phase === "disarmed" && client.canDispatch("arm")) {
    client.dispatch("arm");
  }
  if (client.state().phase === "armed") {
    client.dispatch("turn");
  }
  if (client.state().phase === "tweak") {
    client.dispatch("tweak"); // the toggle releases tweak back to the turn
  }
  // phase === "turn": activation never cancels (ledger: "⌘B-as-escape
  // silently abandoned turns" — the bug this line's absence would be).
}
