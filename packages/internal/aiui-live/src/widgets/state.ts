/**
 * state.ts — Solid subscriptions over a session. Widgets render ONLY what
 * these expose; nothing in this directory reaches into the wire.
 *
 * Solid 2.0 house rules: two-arg createEffect, cleanup via onCleanup.
 */

import { createSignal, onCleanup } from "solid-js";
import type { LiveSession } from "../session";
import type { LedgerEntry, LiveState } from "../types";

export function useLiveState(session: LiveSession): () => LiveState {
  const [state, setState] = createSignal(session.state());
  onCleanup(session.onState(setState));
  return state;
}

/** The ledger as a growing array (capped; oldest dropped). */
export function useLedger(session: LiveSession, cap = 3000): () => LedgerEntry[] {
  const [entries, setEntries] = createSignal<LedgerEntry[]>([...session.ledger()]);
  onCleanup(
    session.onLedger((entry) => {
      setEntries((previous) => {
        const next =
          previous.length >= cap ? previous.slice(previous.length - cap + 1) : previous.slice();
        next.push(entry);
        return next;
      });
    }),
  );
  return entries;
}

export function ms(value: number | undefined): string {
  return value === undefined ? "—" : `${Math.round(value)} ms`;
}

export function stamp(t: number): string {
  return `${(t / 1000).toFixed(2)}s`;
}
