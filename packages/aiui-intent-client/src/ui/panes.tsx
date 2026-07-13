/**
 * panes.tsx — the turn preview and the event trace, as ordinary Solid
 * components over the lanes' reactive event cursor. Both are pure renders:
 * the preview is `composeIntent` (the SAME first IR pass the channel runs)
 * over the current thread's events, so what you see is literally what will
 * lower; the trace is the raw engine stream, newest last. Nothing here is
 * hand-synced — `threadEvents()` subscribes to the cursor.
 */

import {
  type ComposedItem,
  composeIntent,
  type IntentEvent,
} from "@habemus-papadum/aiui-dev-overlay/intent-pipeline";
import { createMemo, For, Show } from "solid-js";
import type { ChannelLanes } from "../lanes";

export const PANES_STYLES = `
  .aiui-pane { margin: 8px 12px; font: 12px system-ui; max-width: 460px; }
  .aiui-pane summary { cursor: pointer; opacity: 0.75; }
  .aiui-pane-list { margin: 4px 0 0; padding: 0; list-style: none; }
  .aiui-pane-list li { padding: 2px 0; border-bottom: 1px dashed color-mix(in srgb, currentColor 12%, transparent); }
  .aiui-pane-kind { display: inline-block; min-width: 84px; font: 11px ui-monospace, monospace;
    opacity: 0.6; }
  .aiui-pane-thumb { max-height: 40px; border-radius: 3px; vertical-align: middle; }
  .aiui-trace-at { font: 10px ui-monospace, monospace; opacity: 0.45; margin-right: 6px; }
`;

/** One composed item, rendered small (text snippets, shot thumbs, markers). */
function ComposedRow(props: { item: ComposedItem }) {
  const text = () => {
    const item = props.item as ComposedItem & { text?: string; marker?: string };
    if (typeof item.text === "string") {
      return item.text.length > 120 ? `${item.text.slice(0, 120)}…` : item.text;
    }
    return item.marker ?? "";
  };
  const thumb = () => (props.item as { thumb?: string }).thumb;
  return (
    <li>
      <span class="aiui-pane-kind">{props.item.kind}</span>
      <Show when={thumb()}>
        {(src) => <img class="aiui-pane-thumb" src={src()} alt="shot thumb" />}
      </Show>
      <span> {text()}</span>
    </li>
  );
}

/**
 * The turn preview: what the open turn will lower to (composeIntent's
 * items). Empty turns say so — the "send would cancel" affordance.
 */
export function TurnPane(props: { lanes: ChannelLanes }) {
  const composed = createMemo(() =>
    composeIntent(props.lanes.threadEvents(), "replace", { streaming: true }),
  );
  return (
    <details class="aiui-pane" data-testid="turn-pane" open>
      <summary>
        turn preview — {composed().items.length} item{composed().items.length === 1 ? "" : "s"}
      </summary>
      <Show
        when={composed().items.length > 0}
        fallback={<div style="opacity: 0.6; margin-top: 4px">empty turn (send would cancel)</div>}
      >
        <ul class="aiui-pane-list">
          <For each={composed().items}>{(item) => <ComposedRow item={item} />}</For>
        </ul>
      </Show>
    </details>
  );
}

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
  const events = createMemo(() => {
    void props.lanes.eventsRev();
    return props.lanes.engine.events.slice(-TRACE_LIMIT);
  });
  return (
    <details class="aiui-pane" data-testid="trace-pane">
      <summary>
        trace — {props.lanes.engine.events.length} event
        {props.lanes.engine.events.length === 1 ? "" : "s"}
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
