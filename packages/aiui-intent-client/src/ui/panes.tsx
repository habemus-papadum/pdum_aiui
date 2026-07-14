/**
 * panes.tsx — the raw engine trace, an ordinary Solid component over the
 * lanes' reactive event cursor (the turn preview grew into its own file:
 * ui/turn-preview.tsx). Newest last, capped; every read goes through the
 * cursor — nothing here is hand-synced.
 */

import type { IntentEvent } from "@habemus-papadum/aiui-dev-overlay/intent-pipeline";
import { createMemo, For } from "solid-js";
import type { ChannelLanes } from "../lanes";

export const PANES_STYLES = `
  .aiui-pane { margin: 8px 12px; font: 12px system-ui; max-width: 460px; }
  .aiui-pane summary { cursor: pointer; opacity: 0.75; }
  .aiui-pane-list { margin: 4px 0 0; padding: 0; list-style: none; }
  .aiui-pane-list li { padding: 2px 0; border-bottom: 1px dashed color-mix(in srgb, currentColor 12%, transparent); }
  .aiui-pane-kind { display: inline-block; min-width: 84px; font: 11px ui-monospace, monospace;
    opacity: 0.6; }
  .aiui-trace-at { font: 10px ui-monospace, monospace; opacity: 0.45; margin-right: 6px; }
`;

const TRACE_LIMIT = 40;

/** One raw engine event, summarized to a line. */
function traceLine(event: IntentEvent): string {
  const e = event as IntentEvent & Record<string, unknown>;
  switch (event.type) {
    case "transcript-delta":
    case "transcript-final":
      return String(e.text ?? "");
    case "navigation":
      return `${e.from} → ${e.to}`;
    case "shot":
      return String(e.marker ?? "");
    case "thread-close":
      return String(e.reason ?? "");
    case "armed":
      return e.on === true ? "on" : "off";
    default: {
      const marker = e.marker ?? e.kind ?? "";
      return String(marker);
    }
  }
}

/** The raw engine stream, newest last, capped — the mode timeline's sibling. */
export function TracePane(props: { lanes: ChannelLanes }) {
  // `engine.events` is a plain array the wire pushes to — reading its length
  // straight from the JSX subscribes to NOTHING, so the count sat at 0 while
  // events poured in (found live, Phase 3). Every read of it goes through the
  // cursor; that is what makes it a reactive read.
  const total = createMemo(() => {
    void props.lanes.eventsRev();
    return props.lanes.engine.events.length;
  });
  const events = createMemo(() => {
    void props.lanes.eventsRev();
    return props.lanes.engine.events.slice(-TRACE_LIMIT);
  });
  return (
    <details class="aiui-pane" data-testid="trace-pane">
      <summary>
        trace — {total()} event{total() === 1 ? "" : "s"}
      </summary>
      <ul class="aiui-pane-list">
        <For each={events()}>
          {(event) => (
            <li>
              <span class="aiui-trace-at">
                {new Date(event.at).toLocaleTimeString(undefined, { hour12: false })}
              </span>
              <span class="aiui-pane-kind">{event.type}</span>
              <span> {traceLine(event)}</span>
            </li>
          )}
        </For>
      </ul>
    </details>
  );
}
