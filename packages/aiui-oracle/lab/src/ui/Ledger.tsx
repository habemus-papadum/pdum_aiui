/**
 * Ledger.tsx — the lab's session view: every ledger entry as one line, newest
 * at the bottom. The session-viewer widget grows out of this (O2b); the lab
 * keeps a raw, honest rendering.
 */

import type { LedgerEntry, OracleSession } from "@habemus-papadum/aiui-oracle";
import { createSignal, For, onCleanup } from "solid-js";

function body(entry: LedgerEntry): string {
  switch (entry.kind) {
    case "session":
      return `${entry.phase}${entry.detail !== undefined ? ` — ${entry.detail}` : ""}`;
    case "config": {
      const tools = Array.isArray(entry.effective?.tools) ? entry.effective.tools.length : "?";
      const drift =
        entry.drift !== undefined && entry.drift.length > 0
          ? ` DRIFT: ${entry.drift.join("; ")}`
          : "";
      return `effective (${tools} tools)${drift}`;
    }
    case "speech":
      return entry.phase;
    case "heard":
      return entry.text;
    case "said":
      return entry.text;
    case "tool-call":
      return `${entry.name}(${entry.args}) [${entry.status}${
        entry.gateMs !== undefined ? `, gate ${entry.gateMs}ms` : ""
      }]`;
    case "tool-result":
      return `${entry.name} ${entry.ok ? "→" : "✗"} ${entry.output} (${entry.ms}ms)`;
    case "injected":
      return `${entry.role}: ${entry.text ?? ""}${entry.image === true ? " [image]" : ""}`;
    case "response":
      return `${entry.status}${
        entry.usage !== undefined
          ? ` · in ${entry.usage.inputTokens} (${entry.usage.cachedInputTokens} cached) / out ${entry.usage.outputTokens}`
          : ""
      }`;
    case "error":
      return `${entry.source}: ${entry.message}`;
    case "raw":
      return `${entry.type} ${JSON.stringify(entry.event).slice(0, 160)}`;
  }
}

export function Ledger(props: { session: OracleSession }) {
  const [entries, setEntries] = createSignal<LedgerEntry[]>([...props.session.ledger()]);
  const off = props.session.onLedger(() => setEntries([...props.session.ledger()]));
  onCleanup(off);
  return (
    <div class="lab-ledger">
      <For each={entries()}>
        {(entry) => (
          <div class="lab-ledger-entry" data-kind={entry.kind}>
            <span class="lab-ledger-kind">{entry.kind}</span>
            <span class="lab-ledger-body">{body(entry)}</span>
          </div>
        )}
      </For>
    </div>
  );
}
