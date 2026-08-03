/**
 * activation.ts — the invocation gesture, reduced to its one irreplaceable
 * job: **recording the capture grant** (owner, 2026-07-20).
 *
 * It used to be the idempotent grant-and-open ladder (arm if disarmed, open a
 * turn if armed — the ⌘B semantics the retired client paid
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
import { grantAnchor, withGrant } from "./spec";

export function activationGesture(client: IntentClient, grantTab: number | undefined): void {
  if (grantTab !== undefined) {
    // The grant joins the LEDGER (per-tab, like Chrome's own standing — owner,
    // 2026-08-03) and the anchor re-derives: granting one tab must not forget
    // another's still-live grant, or returning to it re-asks for what Chrome
    // still remembers.
    const ctx = client.context();
    const grantedTabs = withGrant(ctx.grantedTabs, grantTab);
    client.setContext({ grantedTabs, grantedTab: grantAnchor(grantedTabs, ctx.activeTab) });
  }
}
