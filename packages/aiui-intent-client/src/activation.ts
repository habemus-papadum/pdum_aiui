/**
 * activation.ts — the invocation gesture, reduced to its one irreplaceable
 * job: **recording the capture grant** (owner, 2026-07-20).
 *
 * It used to be the idempotent grant-and-open ladder (arm if disarmed, open a
 * turn if armed, resume from tweak — the ⌘B semantics the retired client paid
 * for live). Both halves of that escalation moved out:
 *
 *  - **arming belongs to the connection now** — the client arms itself on the
 *    channel-connected edge (client.ts setContext), so a gesture never needs
 *    to arm;
 *  - **turns are deliberate** — only the turn cap / its key opens one; an
 *    extension invocation must not (decided: a toolbar click that auto-opened
 *    a turn surprised more than it helped).
 *
 * What remains is the imperative → Solid boundary in its smallest form: the
 * gesture MINTS a world fact (in the MV3 tier `tabCapture` standing is
 * invocation-gated — the toolbar click and the context-menu item ARE the
 * invocations, so this call is the grant becoming a fact; BEHAVIOR.md) and
 * writes it into context. It never touches the phase ladder.
 */

import type { IntentClient } from "./client";

export function activationGesture(client: IntentClient, grantTab: number | undefined): void {
  if (grantTab !== undefined) {
    client.setContext({ grantedTab: grantTab });
  }
}
