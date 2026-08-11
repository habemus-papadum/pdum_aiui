/**
 * oracle-contributions.ts — shots and selections routed to the ORACLE sink
 * (O3d of the intent-oracle proposal, git history).
 *
 * The two things the owner wanted carried into oracle mode. The caps and keys
 * are the same ones a turn uses — 🖼 shot, ⛶ area, 📋 selection, `s`/`a`/`p` —
 * because the hoist put them on the armed tier for exactly this; only the
 * DESTINATION forks, and it forks here.
 *
 * **The format is the lowered prompt's**, by calling the same exported
 * renderers rather than reimplementing them (the defer-rendering rule). What
 * is NOT reused is `composeIntent`: its five passes exist to order MANY events
 * into ONE prompt, and a conversation is already ordered by arrival, so the
 * timestamp interleave, the retraction fold, and the correction application
 * are unnecessary **by construction** — not skipped.
 *
 * Two decided details (owner, 2026-07-30):
 *  - **`respond: false`** — an item lands in the conversation and whatever the
 *    user says next picks it up. Forcing a response would make the oracle talk
 *    over a user who is mid-sentence.
 *  - **role `user`** — not `system`. System-role `conversation.item.create` is
 *    on the founding proposal's spike list, unverified, and the house rule is
 *    to never design on an unverified vendor param.
 */

import {
  type AppSelection,
  type LocatedComponent,
  type Rect,
  renderAppSelection,
  renderShotMetadata,
} from "@habemus-papadum/aiui-lowering-pipeline";
import type { OracleSession } from "@habemus-papadum/aiui-oracle";

/** A captured image on its way to the oracle, as the host hands it over. */
export interface OracleShot {
  /** Raw bytes + mime from `host.capture`, for the data URL the vendor takes. */
  bytes: Uint8Array;
  mime: string;
  rect: Rect;
  /** Located elements, when the page is instrumented and the shot framed any. */
  components?: LocatedComponent[];
  /** A whole-viewport shot carries no element metadata, by design. */
  viewport?: boolean;
  /** True for a rubber-band area drag — worth saying, since it says WHY the
   * framing is what it is. */
  area?: boolean;
}

/**
 * The caption a shot carries into the conversation.
 *
 * This is the one place the oracle's format legitimately diverges from the
 * lowered prompt's, and the divergence is forced: the prompt says
 * `[screenshot located at <path>]` because the image is a file the agent will
 * open, while here the pixels ride INLINE as an attachment. Emitting a path —
 * or the `MISSING` fallback — would be a lie about where the image is. So the
 * bracket line is the oracle's own and the `<screenshot-metadata>` block under
 * it is byte-identical to the prompt's, from the shared renderer.
 */
export function oracleShotCaption(shot: OracleShot): string {
  const what = shot.area
    ? "screenshot of the area I selected"
    : "screenshot of what I'm looking at";
  const size = `${Math.round(shot.rect.w)}×${Math.round(shot.rect.h)}`;
  const head = `[${what} — ${size}${shot.viewport === true ? ", full viewport" : ""}]`;
  if (shot.viewport === true) {
    return head;
  }
  // `attached="true"` is this framing's identity attribute, where the prompt
  // uses `path` or `marker`: the same block, honest about where the pixels are.
  const meta = renderShotMetadata(shot.components ?? [], 'attached="true"');
  return meta === undefined ? head : `${head}\n${meta}`;
}

/** Send one shot to the live oracle session as an attached image. */
export function sendShotToOracle(session: OracleSession, shot: OracleShot): void {
  const binary = Array.from(shot.bytes, (byte) => String.fromCharCode(byte)).join("");
  const dataUrl = `data:${shot.mime};base64,${btoa(binary)}`;
  session.sendImage(dataUrl, oracleShotCaption(shot), { respond: false });
}

/**
 * Send one on-screen selection to the live oracle session.
 *
 * `renderAppSelection` verbatim — the same bracket line and
 * `<selection-metadata>` sidecar the lowered prompt uses, which is precisely
 * what that export exists for. `cwd` is undefined in a browser, so paths stay
 * absolute: honest, not a fudge.
 */
export function sendSelectionToOracle(session: OracleSession, selection: AppSelection): void {
  session.sendText(renderAppSelection(selection), { respond: false, role: "user" });
}
