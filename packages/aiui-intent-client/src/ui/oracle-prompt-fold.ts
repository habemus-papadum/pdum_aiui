/**
 * oracle-prompt-fold.ts — the pure derivation behind the panel's startup-prompt
 * rows: which of a session's ledger entries carried a WOVEN instruction set,
 * and whether each one OPENED a connection or replaced it mid-session.
 *
 * The data was already in the ledger, unread: every `session.update` we send is
 * recorded as a `config` entry with its `sent` payload, and `instructions` — the
 * whole weave, persona + app blurb + tab prelude — rides in it (aiui-oracle's
 * prompt.ts: "the session ledger records the woven whole"). So this is a
 * projection, never a second record: nothing here asks the session for
 * anything, and display cannot drift from what was actually sent.
 *
 * Two rules the fold exists to apply:
 *  - an UNCHANGED re-send is not a weave. `setSessionParam` puts the whole
 *    updatable session on the wire (turn detection has no verified field-level
 *    patch), so tuning a slider three times acks three config entries carrying
 *    identical instructions — and three identical prompt rows would be noise.
 *  - a RECONNECT re-opens the question. The lane holds one session for the
 *    panel's life and its ledger accumulates across connects, so "the prompt
 *    this connection started with" is per-connection: the first weave after a
 *    `connecting` entry is a startup prompt even when its text is the one the
 *    previous connection ended on.
 *
 * Pure and DOM-free so both rules are unit-tested without rendering (the house
 * recipe, and the shape aiui-oracle's own viewer-model.ts uses).
 */

import type { LedgerEntry } from "@habemus-papadum/aiui-oracle";

export interface PromptWeave {
  /** The seq of the `config` entry that carried it — the ledger anchor, and
   * the row's stable key. */
  seq: number;
  /** When that entry was recorded (ms). */
  at: number;
  /** The woven instructions, verbatim. */
  text: string;
  /** `startup` opened a connection; `re-woven` replaced it mid-session (the
   * panel re-weaves with the tab record once a session is live — see
   * `lanes/oracle.ts`'s `applyPrelude`). */
  kind: "startup" | "re-woven";
}

/**
 * Fold a ledger into the weaves it recorded, in order. APPEND-ONLY over a
 * growing ledger: an earlier entry's row never changes, which is what lets the
 * component keep row identity (and an expanded row expanded) as the session
 * runs.
 */
export function promptWeaves(entries: readonly LedgerEntry[]): PromptWeave[] {
  const weaves: PromptWeave[] = [];
  let last: string | undefined;
  /** Whether the next weave OPENS a connection. True before the first one:
   * a ledger that somehow starts with a config entry still reads as a startup
   * rather than as a re-weave of nothing. */
  let opening = true;
  for (const entry of entries) {
    if (entry.kind === "session" && entry.phase === "connecting") {
      last = undefined;
      opening = true;
      continue;
    }
    if (entry.kind !== "config") {
      continue;
    }
    const text = entry.sent?.instructions;
    if (typeof text !== "string" || text === "" || text === last) {
      continue;
    }
    last = text;
    weaves.push({ seq: entry.seq, at: entry.at, text, kind: opening ? "startup" : "re-woven" });
    opening = false;
  }
  return weaves;
}

/** The row's one line while collapsed: what it is, and how much of it there is
 * (the size is the reason it is collapsed in the first place). */
export function weaveSummary(weave: PromptWeave): string {
  const label = weave.kind === "startup" ? "startup prompt" : "prompt re-woven";
  return `${label} · ${weave.text.length} chars`;
}
