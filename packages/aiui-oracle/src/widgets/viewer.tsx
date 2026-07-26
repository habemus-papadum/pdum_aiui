/**
 * viewer.tsx — the session's two faces over one ledger:
 *
 *  - {@link OracleMind} — the ambient cue strip: one line answering "what is
 *    it doing right now" (listening / thinking / doing: set_freq / parked),
 *    for END USERS of an app that embeds the oracle.
 *  - {@link OracleViewer} — the debugging view: TURN-grouped ledger with
 *    progressive detail (turn line → entries → entry payload as JSON) and
 *    category chips whose defaults keep the chatter off. Latest turn open,
 *    history collapsed, pinned to live.
 *
 * Both render exclusively from the session's state + ledger — no vendor
 * knowledge, any transport.
 */

import { createMemo, createSignal, For, Show } from "solid-js";
import type { OracleSession } from "../session";
import type { LedgerEntry } from "../types";
import { useOracleState } from "./control";
import {
  ALL_CATEGORIES,
  activityLine,
  categoryOf,
  defaultCategories,
  entryDetail,
  entryLine,
  groupTurns,
  type LedgerCategory,
  summarizeTurn,
} from "./viewer-model";

export function OracleMind(props: { session: OracleSession }) {
  const state = useOracleState(props.session);
  const line = () => activityLine(state());
  return (
    <div class="aiui-oracle-mind" data-status={state().status}>
      <span class="aiui-oracle-mind-icon">{line().icon}</span>
      <span class="aiui-oracle-mind-text">{line().text}</span>
    </div>
  );
}

function useLedger(session: OracleSession): () => readonly LedgerEntry[] {
  const [entries, setEntries] = createSignal<readonly LedgerEntry[]>([...session.ledger()]);
  session.onLedger(() => setEntries([...session.ledger()]));
  return entries;
}

function EntryRow(props: { entry: LedgerEntry }) {
  const [open, setOpen] = createSignal(false);
  const detail = entryDetail(props.entry);
  return (
    <div class="aiui-oracle-entry" data-kind={props.entry.kind}>
      <button
        type="button"
        class="aiui-oracle-entry-line"
        disabled={detail === undefined}
        onClick={() => setOpen(!open())}
      >
        <span class="aiui-oracle-entry-kind">{props.entry.kind}</span>
        <span class="aiui-oracle-entry-body">{entryLine(props.entry)}</span>
      </button>
      <Show when={open() && detail !== undefined}>
        <pre class="aiui-oracle-entry-json">{JSON.stringify(detail, null, 2)}</pre>
      </Show>
    </div>
  );
}

export interface OracleViewerProps {
  session: OracleSession;
  /** Show the mind strip on top. Default true. */
  mind?: boolean;
}

export function OracleViewer(props: OracleViewerProps) {
  const entries = useLedger(props.session);
  const [enabled, setEnabled] = createSignal<Set<LedgerCategory>>(defaultCategories());
  // Which turn groups the user explicitly toggled (latest is open by default).
  const [toggled, setToggled] = createSignal<Map<number, boolean>>(new Map());

  const groups = createMemo(() => {
    const on = enabled();
    const filtered = entries().filter((entry) => on.has(categoryOf(entry)));
    return groupTurns(filtered);
  });

  const flip = (category: LedgerCategory) => {
    const next = new Set(enabled());
    if (next.has(category)) {
      next.delete(category);
    } else {
      next.add(category);
    }
    setEnabled(next);
  };

  const isOpen = (id: number, last: boolean) => toggled().get(id) ?? last;

  return (
    <div class="aiui-oracle-viewer">
      <Show when={props.mind !== false}>
        <OracleMind session={props.session} />
      </Show>
      <div class="aiui-oracle-chips">
        <For each={ALL_CATEGORIES}>
          {(category) => (
            <button
              type="button"
              class="aiui-oracle-chip"
              data-on={enabled().has(category)}
              onClick={() => flip(category)}
            >
              {category}
            </button>
          )}
        </For>
      </div>
      <div class="aiui-oracle-turns">
        <For each={groups()}>
          {(group, index) => {
            const last = () => index() === groups().length - 1;
            return (
              <div class="aiui-oracle-turn" data-open={isOpen(group.id, last())}>
                <button
                  type="button"
                  class="aiui-oracle-turn-summary"
                  onClick={() =>
                    setToggled(new Map(toggled()).set(group.id, !isOpen(group.id, last())))
                  }
                >
                  {summarizeTurn(group)}
                </button>
                <Show when={isOpen(group.id, last())}>
                  <div class="aiui-oracle-turn-entries">
                    <For each={group.entries}>{(entry) => <EntryRow entry={entry} />}</For>
                  </div>
                </Show>
              </div>
            );
          }}
        </For>
      </div>
    </div>
  );
}
