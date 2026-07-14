/**
 * panes.tsx — the turn preview and the event trace, as ordinary Solid
 * components over the lanes' reactive event cursor. Both are pure renders:
 * the preview is `composeIntent` (the SAME first IR pass the channel runs)
 * over the current thread's events, so what you see is literally what will
 * lower; the trace is the raw engine stream, newest last. Nothing here is
 * hand-synced — `threadEvents()` subscribes to the cursor.
 *
 * The preview's rendering is the overlay's (multimodal/preview.tsx), ported
 * onto the cursor: a keyed `<For>` where each composed item keeps ONE row —
 * text rows are imperative islands around the kit's `LiveDiffText` (appends
 * render clean; REVISIONS flash the pink/green word-diff and settle — the one
 * visual language for "this text just changed"), and a final that carries
 * word logprobs renders as a HEAT row, each word tinted by how unsure the
 * model was, normalized against the whole turn's confidence range. The
 * low-confidence words are exactly where a spoken correction is likely.
 */

import {
  type ComposedItem,
  composeIntent,
  type IntentEvent,
  type TranscriptWord,
} from "@habemus-papadum/aiui-dev-overlay/intent-pipeline";
import { LiveDiffText } from "@habemus-papadum/aiui-viz/modal";
import { createEffect, createMemo, For, Show, untrack } from "solid-js";
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
  .aiui-seg { opacity: 0.7; }
  .aiui-seg.final { opacity: 1; }
  /* The kit's diff-flash runs (LiveDiffText stamps these class names). */
  .mm-diff-del { color: #ff5c87; background: #ff5c8722; text-decoration: line-through; border-radius: 3px; }
  .mm-diff-add { color: #7ee0a3; background: #7ee0a322; border-radius: 3px; }
`;

/** A composed item's keyed-`<For>` identity (stable across re-folds) — the
 * overlay's scheme, verbatim: a row keeps its DOM across every re-compose. */
function keyOf(item: ComposedItem, index: number): string {
  switch (item.kind) {
    case "text":
      return item.segment !== undefined ? `text:${item.segment}` : `text:@${index}`;
    case "shot":
      return `shot:${item.marker ?? `@${index}`}`;
    case "app-selection":
      return `sel:${item.marker ?? `@${index}`}`;
    case "code-selection":
      return `code:${item.marker ?? `@${index}`}`;
    case "navigation":
      return `nav:@${index}`;
  }
}

/** One preview row: a composed item plus its stable key (and, for a final
 * with confidence, its words — the heat row's data). */
interface Piece {
  item: ComposedItem;
  key: string;
  words?: TranscriptWord[];
}

/**
 * The turn preview: what the open turn will lower to (composeIntent's
 * items). Empty turns say so — the "send would cancel" affordance.
 */
export function TurnPane(props: { lanes: ChannelLanes }) {
  const pieces = createMemo<Piece[]>(() => {
    const events = props.lanes.threadEvents();
    const items = composeIntent(events, "replace", { streaming: true }).items;
    // Word-level confidence per segment (the heat map's data), from the
    // latest transcript-final that carried words.
    const wordsBySegment = new Map<number, TranscriptWord[]>();
    for (const event of events) {
      if (event.type === "transcript-final" && event.words !== undefined) {
        wordsBySegment.set(event.segment, event.words);
      }
    }
    // Uniquify repeated keys: the compiler may split one segment's text
    // around a timestamp-anchored shot — each occurrence gets its own row.
    const seen = new Map<string, number>();
    return items.map((item, index) => {
      const base = keyOf(item, index);
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      const words =
        item.kind === "text" && item.segment !== undefined
          ? wordsBySegment.get(item.segment)
          : undefined;
      // Heat only for UNSPLIT rows (the words map 1:1 onto the text).
      const heat =
        words !== undefined &&
        n === 0 &&
        words.map((w) => w.text).join(" ").length >= (item.text ?? "").length;
      // The `:w` suffix is LOAD-BEARING (the overlay's live lesson): a keyed
      // row's shape is decided once, so the provisional run's plain row would
      // survive the final and the heat branch would be unreachable — words
      // changing the KEY forces the <For> to rebuild the row as a heat row.
      const key = `${n === 0 ? base : `${base}#${n}`}${heat ? ":w" : ""}`;
      return { item, key, ...(heat ? { words } : {}) };
    });
  });

  /** The turn-wide logprob range: each heat word normalizes against THIS, so
   * the gradation is relative to the turn's own confidence distribution (an
   * absolute scale would wash out — vendors sit in different bands). */
  const logprobRange = createMemo(() => {
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (const piece of pieces()) {
      for (const word of piece.words ?? []) {
        if (word.logprob !== undefined) {
          min = Math.min(min, word.logprob);
          max = Math.max(max, word.logprob);
        }
      }
    }
    return min < max ? { min, max } : undefined;
  });

  /** A final row WITH word confidence: per-word spans, tinted where the
   * model was unsure. */
  const heatRow = (key: string) => {
    const current = createMemo(() => pieces().find((p) => p.key === key));
    return (
      <span class="aiui-seg final" data-testid="heat-row">
        <For each={current()?.words ?? []}>
          {(word) => {
            // The range spans EVERY word in the turn, so a later segment can
            // widen it and retint words already on screen. A <For> child body
            // runs once, untracked — reading the memo HERE would freeze this
            // word's tint at insert time. Its own memo keeps it live.
            const alpha = createMemo(() => {
              const range = logprobRange();
              if (range === undefined || word.logprob === undefined) {
                return 0;
              }
              const normalized = (word.logprob - range.min) / (range.max - range.min);
              return (1 - normalized) * 0.45;
            });
            return (
              <>
                <span
                  style={
                    alpha() > 0.04
                      ? { background: `rgba(255, 92, 135, ${alpha().toFixed(3)})` }
                      : {}
                  }
                  title={word.logprob !== undefined ? `logprob ${word.logprob.toFixed(2)}` : ""}
                >
                  {word.text}
                </span>{" "}
              </>
            );
          }}
        </For>
      </span>
    );
  };

  /**
   * One text run — an imperative island around the kit's LiveDiffText:
   * extensions render clean, and any REVISION (a streaming self-correction, a
   * final disagreeing with its last delta) flashes the word-diff and settles.
   * The diff animation doctrine: Solid renders structure; the island owns its
   * clock.
   */
  const textRow = (key: string) => {
    const host = document.createElement("span");
    const live = new LiveDiffText(host);
    const current = createMemo(() => pieces().find((p) => p.key === key));
    createEffect(
      () => ({
        text: current()?.item.text ?? "",
        provisional:
          (current()?.item as { provisional?: boolean } | undefined)?.provisional === true,
      }),
      ({ text, provisional }) => {
        host.className = provisional ? "aiui-seg" : "aiui-seg final";
        live.update(text);
      },
    );
    return <>{host}</>;
  };

  const shotRow = (key: string) => {
    const current = createMemo(() => pieces().find((p) => p.key === key));
    return (
      <>
        <Show when={current()?.item.thumb}>
          {(src) => <img class="aiui-pane-thumb" src={src()} alt="shot thumb" />}
        </Show>
        <span> {current()?.item.marker ?? ""}</span>
      </>
    );
  };

  const plainRow = (key: string) => {
    const current = createMemo(() => pieces().find((p) => p.key === key));
    const text = () => {
      const item = current()?.item;
      if (item === undefined) {
        return "";
      }
      if (item.kind === "navigation") {
        return `${item.from ?? ""} → ${item.to ?? ""}`;
      }
      const t = item.text ?? item.marker ?? "";
      return t.length > 120 ? `${t.slice(0, 120)}…` : t;
    };
    return <span> {text()}</span>;
  };

  return (
    <details class="aiui-pane" data-testid="turn-pane" open>
      <summary>
        turn preview — {pieces().length} item{pieces().length === 1 ? "" : "s"}
      </summary>
      <Show
        when={pieces().length > 0}
        fallback={<div style="opacity: 0.6; margin-top: 4px">empty turn (send would cancel)</div>}
      >
        <ul class="aiui-pane-list">
          <For each={pieces()} keyed={(piece) => piece.key}>
            {(piece) => {
              // One-shot read (hence untrack): a key's kind never changes, so
              // the row SHAPE is decided once; content stays reactive via the
              // key-scoped memos inside each row.
              const p = untrack(piece);
              return (
                <li>
                  <span class="aiui-pane-kind">{p.item.kind}</span>
                  {p.item.kind === "shot"
                    ? shotRow(p.key)
                    : p.words?.some((w) => w.logprob !== undefined)
                      ? heatRow(p.key)
                      : p.item.kind === "text"
                        ? textRow(p.key)
                        : plainRow(p.key)}
                </li>
              );
            }}
          </For>
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
