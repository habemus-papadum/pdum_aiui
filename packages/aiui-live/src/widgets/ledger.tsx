/**
 * ledger.tsx — the raw record: every event in and out with its time since
 * connect, filterable by kind, expandable to the JSON. The wire lab's
 * primary instrument — the numbers in the proposal were read off this.
 */

import { createMemo, createSignal, For, Show } from "solid-js";
import type { LiveSession } from "../session";
import type { LedgerEntry, LedgerKind } from "../types";
import { stamp, useLedger } from "./state";

export const ALL_KINDS: LedgerKind[] = [
  "session",
  "delegation",
  "append",
  "ack",
  "transcript",
  "response",
  "backend",
  "usage",
  "error",
  "note",
  "raw",
];

export interface LiveLedgerProps {
  session: LiveSession;
  /** Kinds shown initially. Default: all but `transcript`. */
  kinds?: LedgerKind[];
  /** Rows kept on screen (newest). Default 400. */
  limit?: number;
}

export function LiveLedger(props: LiveLedgerProps) {
  const entries = useLedger(props.session);
  const [on, setOn] = createSignal<Set<LedgerKind>>(
    new Set(props.kinds ?? ALL_KINDS.filter((kind) => kind !== "transcript")),
  );
  const [openSeq, setOpenSeq] = createSignal<number | undefined>(undefined);
  const visible = createMemo(() => {
    const keep = on();
    const all = entries().filter((entry) => keep.has(entry.kind));
    const limit = props.limit ?? 400;
    return all.length > limit ? all.slice(all.length - limit) : all;
  });
  const toggle = (kind: LedgerKind) => {
    const next = new Set(on());
    if (next.has(kind)) {
      next.delete(kind);
    } else {
      next.add(kind);
    }
    setOn(next);
  };
  return (
    <div class="aiui-live-ledger">
      <div class="aiui-live-chips">
        <For each={ALL_KINDS}>
          {(kind) => (
            <button
              type="button"
              class="aiui-live-chip"
              data-on={String(on().has(kind))}
              onClick={() => toggle(kind)}
            >
              {kind}
            </button>
          )}
        </For>
        <span class="aiui-live-ledger-count">{entries().length} entries</span>
      </div>
      <div class="aiui-live-rows">
        <For each={visible()}>
          {(entry) => (
            <Row
              entry={entry}
              open={openSeq() === entry.seq}
              onToggle={() => setOpenSeq(openSeq() === entry.seq ? undefined : entry.seq)}
            />
          )}
        </For>
      </div>
    </div>
  );
}

function Row(props: { entry: LedgerEntry; open: boolean; onToggle(): void }) {
  const arrow = () => (props.entry.dir === "in" ? "←" : props.entry.dir === "out" ? "→" : "·");
  return (
    <div class="aiui-live-row" data-kind={props.entry.kind} data-dir={props.entry.dir}>
      <button
        type="button"
        class="aiui-live-row-line"
        disabled={props.entry.event === undefined}
        onClick={props.onToggle}
      >
        <span class="aiui-live-row-t">{stamp(props.entry.t)}</span>
        <span class="aiui-live-row-dir">{arrow()}</span>
        <span class="aiui-live-row-kind">{props.entry.kind}</span>
        <span class="aiui-live-row-summary">{props.entry.summary}</span>
      </button>
      <Show when={props.open && props.entry.event}>
        {(event) => <pre class="aiui-live-row-json">{JSON.stringify(event(), null, 1)}</pre>}
      </Show>
    </div>
  );
}
