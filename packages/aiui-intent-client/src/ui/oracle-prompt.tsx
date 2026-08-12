/**
 * oracle-prompt.tsx — the woven instructions, shown where the session's own
 * record is read: one COLLAPSED row per weave, above the ledger's transcript.
 *
 * The prompt the oracle is standing on was the one thing the panel could not
 * see. It was in the ledger (every `config` entry carries the `sent` payload)
 * but only as a field of a JSON blob two clicks deep, which is not a place
 * anyone reads a persona. So it rides as its own row — and DEFAULT COLLAPSED,
 * because it is a page of dense text that would otherwise bury the transcript
 * it belongs to.
 *
 * A re-weave appends a row rather than rewriting the first one: what the
 * session started with and what it holds now are different facts, and the
 * panel re-weaves mid-session on every tab change (`applyPrelude`). Display
 * only — nothing here touches the session.
 */

import type { OracleSession } from "@habemus-papadum/aiui-oracle";
import { createSignal, For, onCleanup, Show } from "solid-js";
import { type PromptWeave, promptWeaves, weaveSummary } from "./oracle-prompt-fold";

export const ORACLE_PROMPT_STYLES = `
  /* Rows read as ledger lines (the viewer's monospace idiom), not as panes. */
  .aiui-oracle-prompts { display: flex; flex-direction: column; gap: 2px; margin: 0 0 6px; }
  .aiui-oracle-prompt { font: 11px ui-monospace, monospace; }
  .aiui-oracle-prompt summary { cursor: pointer; opacity: 0.55; }
  .aiui-oracle-prompt[open] summary { opacity: 0.85; }
  /* Wrapped, not scrolled sideways — a persona is prose, and a horizontal
     scrollbar under 460px of side panel makes it unreadable. Capped in height
     so an open row cannot push the transcript off the fold. */
  .aiui-oracle-prompt-text { margin: 3px 0 4px; padding: 5px; border-radius: 6px;
    background: color-mix(in srgb, currentColor 8%, transparent);
    white-space: pre-wrap; word-break: break-word;
    max-height: 260px; overflow-y: auto; }
`;

/** The session's woven prompts, newest last. Renders nothing until a session
 * has actually been configured — an empty block above the ledger would claim
 * the panel knows a prompt it has never seen. */
export function OraclePromptWeaves(props: { session: OracleSession }) {
  const [weaves, setWeaves] = createSignal<PromptWeave[]>(promptWeaves(props.session.ledger()), {
    ownedWrite: true,
  });
  onCleanup(
    props.session.onLedger((entry) => {
      // Only a config ack can add a weave, and they are rare — so the fold runs
      // over the whole ledger on those entries alone rather than on the
      // (high-frequency) rest of the stream.
      if (entry.kind !== "config") {
        return;
      }
      const next = promptWeaves(props.session.ledger());
      const current = weaves();
      if (next.length <= current.length) {
        return; // an unchanged re-send: the fold already said so
      }
      // APPEND the tail rather than swapping in the new array. The fold is
      // append-only, so the earlier rows are the same rows — and keeping their
      // identity is what keeps `<For>`'s DOM alive, so a prompt someone
      // expanded stays expanded when the next weave lands.
      setWeaves([...current, ...next.slice(current.length)]);
    }),
  );
  return (
    <Show when={weaves().length > 0}>
      <div class="aiui-oracle-prompts" data-testid="oracle-prompts">
        <For each={weaves()}>
          {(weave) => (
            <details
              class="aiui-oracle-prompt"
              data-testid="oracle-prompt"
              data-kind={weave.kind}
              data-seq={weave.seq}
            >
              <summary>{weaveSummary(weave)}</summary>
              <pre class="aiui-oracle-prompt-text">{weave.text}</pre>
            </details>
          )}
        </For>
      </div>
    </Show>
  );
}
