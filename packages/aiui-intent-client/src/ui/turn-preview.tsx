/**
 * turn-preview.tsx — the turn preview, with the overlay's accumulator UX
 * (owner, 2026-07-14: same functionality, logic living in THIS repo, done
 * properly in Solid). The pieces:
 *
 *  - **text runs** are LiveDiffText islands (appends render clean, revisions
 *    flash the word-diff and settle) and, once a final carries word logprobs,
 *    **heat rows** — each word tinted by the turn's own confidence range;
 *  - **shots** are real thumbnails (amber-bordered, 34px) with a hover PEEK
 *    (fixed-position, flipping above/below — the scroll-clip lesson) and a
 *    hover ✕ that retracts the shot from the turn through the wire engine;
 *  - **selections** are minimal pills (⌖ sel_1 on-screen, ⧉ code_1 from an
 *    editor) whose substance lives in the hover peek (source location + the
 *    text, CSS-clamped) — with the same retracting ✕;
 *  - **navigations** are ⇢ route chips: markers, not content, never
 *    retractable — the page really did change;
 *  - **the accumulator is per-turn**: no open thread renders NOTHING, so an
 *    abandoned or sent turn resets the preview instead of haunting it (the
 *    exact bug the owner saw: navigations piling into a preview whose turn
 *    had closed).
 *
 * The Solid shape, deliberately: one keyed `<For>` where a row's KIND is
 * decided once (untrack) and its content stays reactive through key-scoped
 * memos; imperative islands only where something genuinely owns a clock or a
 * measurement — LiveDiffText (the kit's settle timer) and the peek (measure
 * after attach, then flip). Ported from the overlay's multimodal/preview.tsx,
 * whose class-plus-render shape this component retires.
 */

import {
  type ComposedItem,
  composeIntent,
  type TranscriptWord,
} from "@habemus-papadum/aiui-dev-overlay/intent-pipeline";
import { LiveDiffText } from "@habemus-papadum/aiui-viz/modal";
import { createEffect, createMemo, For, onCleanup, Show, untrack } from "solid-js";
import type { ChannelLanes } from "../lanes";

export const TURN_PREVIEW_STYLES = `
  .aiui-tp { margin: 8px 12px; font: 12px system-ui; max-width: 460px; }
  .aiui-tp summary { cursor: pointer; opacity: 0.75; }
  .aiui-tp-body { margin-top: 4px; line-height: 2; }
  .aiui-tp-empty { opacity: 0.6; margin-top: 4px; }
  .aiui-tp-seg { opacity: 0.7; }
  .aiui-tp-seg.final { opacity: 1; }
  /* The kit's diff-flash runs (LiveDiffText stamps these class names). */
  .mm-diff-del { color: #ff5c87; background: #ff5c8722; text-decoration: line-through; border-radius: 3px; }
  .mm-diff-add { color: #7ee0a3; background: #7ee0a322; border-radius: 3px; }
  .aiui-tp-heat-word { border-radius: 3px; padding: 0 1px; }
  /* Chips + thumbs — the overlay's visual language, verbatim: amber = pixels,
     blue family = selections, gray = boundaries; substance rides the peek. */
  .aiui-tp-wrap { position: relative; display: inline-block; margin: 0 4px; vertical-align: middle; }
  .aiui-tp-thumb { height: 34px; border-radius: 4px; border: 2px solid #ffd166; vertical-align: middle;
    display: block; }
  .aiui-tp-thumb-chip { font-size: 11px; color: #ffd166; border: 1px solid #3a4152; border-radius: 999px;
    padding: 1px 8px; display: inline-block; }
  .aiui-tp-x { position: absolute; top: -7px; right: -7px; width: 16px; height: 16px; padding: 0;
    border: 1px solid #3a4152; border-radius: 50%; background: #171b25; color: #f28b82;
    font: 10px/1 ui-sans-serif, system-ui; cursor: pointer; display: none; align-items: center;
    justify-content: center; }
  .aiui-tp-wrap:hover .aiui-tp-x { display: flex; }
  .aiui-tp-x:hover { background: #f28b82; color: #171b25; border-color: #f28b82; }
  .aiui-tp-chip { font-size: 11px; border: 1px solid #3a4152; border-radius: 999px;
    padding: 1px 8px; display: inline-block; vertical-align: middle; white-space: nowrap; }
  .aiui-tp-sel-app { color: #8ab4f8; }
  .aiui-tp-sel-code { color: #a5c8ff; }
  .aiui-tp-nav { color: #7ee0a3; }
  /* Peeks: fixed-position and body-attached — the pane scrolls, so an
     absolutely-positioned child would clip (the overlay's measured lesson). */
  .aiui-tp-peek-img { position: fixed; z-index: 2147483644; max-width: min(480px, 60vw);
    max-height: 50vh; border: 2px solid #ffd166; border-radius: 8px; background: #0f1117;
    box-shadow: 0 8px 30px rgba(0, 0, 0, 0.55); pointer-events: none; }
  .aiui-tp-peek { position: fixed; z-index: 2147483644; max-width: min(480px, 60vw);
    border: 1px solid #8ab4f8; border-radius: 8px; background: #0f1117;
    box-shadow: 0 8px 30px rgba(0, 0, 0, 0.55); pointer-events: none;
    padding: 8px 10px; font: 12px/1.5 ui-sans-serif, system-ui, -apple-system, sans-serif; }
  .aiui-tp-peek-loc { color: #9aa0aa; font-size: 11px; margin-bottom: 4px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .aiui-tp-peek-text { color: #e8e8ea; white-space: pre-wrap; word-break: break-word;
    display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 6; overflow: hidden; }
`;

/** A URL as path+query+hash — the origin is noise inside one tab's preview. */
export function shortRoute(url: string | undefined): string {
  if (url === undefined || url === "") {
    return "?";
  }
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}${u.hash}` || url;
  } catch {
    return url;
  }
}

/** A composed item's keyed-`<For>` identity (stable across re-folds). */
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
 * The hover peek, one per component: genuinely imperative (attach, MEASURE,
 * then flip above/below whichever side has room — found live in the old
 * side panel, where a hard-coded "above" clipped off-screen). Everything
 * else about a row is declarative; this owns the measurement.
 */
function createPeek(): {
  showImage: (anchor: HTMLElement, src: string) => void;
  showText: (anchor: HTMLElement, loc: string | undefined, text: string) => void;
  hide: () => void;
} {
  let peek: HTMLElement | undefined;
  const hide = (): void => {
    peek?.remove();
    peek = undefined;
  };
  const place = (anchor: HTMLElement, el: HTMLElement): void => {
    hide();
    const rect = anchor.getBoundingClientRect();
    document.body.append(el);
    peek = el;
    const height = el.getBoundingClientRect().height;
    const gap = 8;
    const above = rect.top - gap;
    const below = window.innerHeight - rect.bottom - gap;
    if (height <= above || above >= below) {
      el.style.top = "";
      el.style.bottom = `${window.innerHeight - rect.top + gap}px`;
    } else {
      el.style.bottom = "";
      el.style.top = `${rect.bottom + gap}px`;
    }
    const width = el.getBoundingClientRect().width;
    const left = Math.min(Math.max(gap, rect.left), Math.max(gap, window.innerWidth - width - gap));
    el.style.left = `${left}px`;
  };
  onCleanup(hide);
  return {
    showImage: (anchor, src) => {
      const img = document.createElement("img");
      img.className = "aiui-tp-peek-img";
      img.src = src;
      place(anchor, img);
    },
    showText: (anchor, loc, text) => {
      const card = document.createElement("div");
      card.className = "aiui-tp-peek";
      if (loc !== undefined) {
        const locEl = document.createElement("div");
        locEl.className = "aiui-tp-peek-loc";
        locEl.textContent = loc;
        card.append(locEl);
      }
      const textEl = document.createElement("div");
      textEl.className = "aiui-tp-peek-text";
      textEl.textContent = text;
      card.append(textEl);
      place(anchor, card);
    },
    hide,
  };
}

/**
 * The turn preview: what the open turn will lower to — composeIntent (the
 * SAME first IR pass the channel runs) over the current thread's events, so
 * what you see is literally what will lower. Per-turn by construction.
 */
export function TurnPreview(props: { lanes: ChannelLanes }) {
  const peek = createPeek();
  const engine = () => props.lanes.engine;
  /** `threadOpen` is a plain engine property; every change to it is an engine
   * EVENT, so reading it under the cursor is what makes it reactive. */
  const threadOpen = createMemo(() => {
    void props.lanes.eventsRev();
    return engine().threadOpen;
  });

  const pieces = createMemo<Piece[]>(() => {
    const events = props.lanes.threadEvents(); // subscribes to the cursor
    // THE reset rule (the overlay's): the accumulator is per-turn — no open
    // thread, no pieces. Abandon/send empties the preview instead of letting
    // between-turn events (navigations above all) haunt a closed turn.
    if (!threadOpen()) {
      return [];
    }
    const items = composeIntent(events, "replace", { streaming: true }).items;
    const wordsBySegment = new Map<number, TranscriptWord[]>();
    for (const event of events) {
      if (event.type === "transcript-final" && event.words !== undefined) {
        wordsBySegment.set(event.segment, event.words);
      }
    }
    // Uniquify repeated keys (the compiler may split one segment's text
    // around a timestamp-anchored shot); the `:w` suffix is LOAD-BEARING —
    // words arriving must RE-KEY the row or the provisional run's plain
    // shape survives the final and the heat branch is unreachable.
    const seen = new Map<string, number>();
    return items.map((item, index) => {
      const base = keyOf(item, index);
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      const words =
        item.kind === "text" && item.segment !== undefined
          ? wordsBySegment.get(item.segment)
          : undefined;
      const heat =
        words !== undefined &&
        n === 0 &&
        words.map((w) => w.text).join(" ").length >= (item.text ?? "").length;
      const key = `${n === 0 ? base : `${base}#${n}`}${heat ? ":w" : ""}`;
      return { item, key, ...(heat ? { words } : {}) };
    });
  });

  /** The turn-wide logprob range: heat normalizes against the turn's own
   * confidence distribution (absolute scales wash out across vendors). */
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

  /** The live item behind a key — rows read content through this so a
   * re-fold (a refinement, a late thumb) updates in place. */
  const byKey = (key: string) => createMemo(() => pieces().find((p) => p.key === key));

  const heatRow = (key: string) => {
    const current = byKey(key);
    return (
      <span class="aiui-tp-seg final" data-testid="heat-row">
        <For each={current()?.words ?? []}>
          {(word) => {
            // Its own memo: a <For> child body runs once, untracked — a bare
            // read here would freeze the tint at insert time.
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
                  class="aiui-tp-heat-word"
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

  /** A text run: an island around the kit's LiveDiffText — Solid renders
   * structure; the island owns its settle clock. */
  const textRow = (key: string) => {
    const host = document.createElement("span");
    const live = new LiveDiffText(host);
    const current = byKey(key);
    createEffect(
      () => ({
        text: current()?.item.text ?? "",
        provisional:
          (current()?.item as { provisional?: boolean } | undefined)?.provisional === true,
      }),
      ({ text, provisional }) => {
        host.className = provisional ? "aiui-tp-seg" : "aiui-tp-seg final";
        live.update(text);
      },
    );
    return <>{host}</>;
  };

  /** A shot: the thumbnail (or the degraded 📷 chip while pixels are still
   * uploading), hover peek, hover ✕ retracting it through the wire engine. */
  const shotRow = (key: string) => {
    const current = byKey(key);
    let wrap: HTMLSpanElement | undefined;
    return (
      // biome-ignore lint/a11y/noStaticElementInteractions: hover peek is enhancement only — title + the inner <button> carry the content accessibly
      <span
        class="aiui-tp-wrap"
        data-testid="shot-chip"
        ref={(el: HTMLSpanElement) => {
          wrap = el;
        }}
        onMouseEnter={() => {
          const thumb = current()?.item.thumb;
          if (thumb !== undefined && thumb !== "" && wrap !== undefined) {
            peek.showImage(wrap, thumb);
          }
        }}
        onMouseLeave={() => peek.hide()}
      >
        <Show
          when={current()?.item.thumb}
          fallback={<span class="aiui-tp-thumb-chip">📷 {current()?.item.marker}</span>}
        >
          {(src) => (
            <img class="aiui-tp-thumb" src={src()} alt={current()?.item.marker ?? "shot"} />
          )}
        </Show>
        <button
          type="button"
          class="aiui-tp-x"
          title={`remove ${current()?.item.marker ?? "this shot"} from this turn`}
          onClick={(event) => {
            event.stopPropagation();
            peek.hide();
            const marker = current()?.item.marker;
            if (marker !== undefined) {
              engine().dropShot(marker);
            }
          }}
        >
          ✕
        </button>
      </span>
    );
  };

  /** A selection — app (⌖) or code (⧉): a minimal pill; substance in the
   * peek (loc + text, CSS-clamped); ✕ retracts exactly this selection. */
  const selectionRow = (key: string, isCode: boolean) => {
    const current = byKey(key);
    let wrap: HTMLSpanElement | undefined;
    const title = () => {
      const item = current()?.item;
      return item?.sourceLoc !== undefined
        ? `${item.sourceLoc}\n${item.text ?? ""}`
        : (item?.text ?? "");
    };
    return (
      // biome-ignore lint/a11y/noStaticElementInteractions: hover peek is enhancement only — title + the inner <button> carry the content accessibly
      <span
        class="aiui-tp-wrap"
        data-testid="selection-chip"
        ref={(el: HTMLSpanElement) => {
          wrap = el;
        }}
        onMouseEnter={() => {
          const item = current()?.item;
          if (item !== undefined && wrap !== undefined) {
            peek.showText(wrap, item.sourceLoc, item.text ?? "");
          }
        }}
        onMouseLeave={() => peek.hide()}
      >
        <span
          class={`aiui-tp-chip ${isCode ? "aiui-tp-sel-code" : "aiui-tp-sel-app"}`}
          title={title()}
        >
          {isCode ? "⧉" : "⌖"} {current()?.item.marker ?? (isCode ? "code" : "sel")}
        </span>
        <button
          type="button"
          class="aiui-tp-x"
          title={`remove this ${isCode ? "code selection" : "selection"} from this turn`}
          onClick={(event) => {
            event.stopPropagation();
            peek.hide();
            const marker = current()?.item.marker;
            if (isCode) {
              if (marker !== undefined) {
                engine().dropCodeSelection(marker);
              }
            } else {
              engine().appSelectionDrop(marker);
            }
          }}
        >
          ✕
        </button>
      </span>
    );
  };

  /** A navigation boundary: a bare ⇢ chip at its stream position — a marker,
   * not content, never retractable (the page really did change). The chip
   * carries NO data (owner, 2026-07-14: icon + color only); the from → to
   * detail lives in the instant hover peek — the native title tooltip's
   * built-in delay is exactly the slowness the peek exists to beat. */
  const navRow = (key: string) => {
    const current = byKey(key);
    let chip: HTMLSpanElement | undefined;
    return (
      // biome-ignore lint/a11y/noStaticElementInteractions: hover peek is enhancement only — the title attribute carries the content accessibly
      <span
        class="aiui-tp-chip aiui-tp-nav"
        data-testid="nav-chip"
        ref={(el: HTMLSpanElement) => {
          chip = el;
        }}
        title={`navigated ${shortRoute(current()?.item.from)} → ${shortRoute(current()?.item.to)}`}
        onMouseEnter={() => {
          const item = current()?.item;
          if (item !== undefined && chip !== undefined) {
            peek.showText(chip, "navigation", `${item.from ?? "?"}\n→ ${item.to ?? "?"}`);
          }
        }}
        onMouseLeave={() => peek.hide()}
      >
        ⇢
      </span>
    );
  };

  return (
    <details class="aiui-tp" data-testid="turn-pane" open>
      <summary>
        turn preview — {pieces().length} item{pieces().length === 1 ? "" : "s"}
      </summary>
      <Show
        when={pieces().length > 0}
        fallback={
          <div class="aiui-tp-empty">
            {threadOpen() ? "empty turn (send would cancel)" : "no open turn"}
          </div>
        }
      >
        <div class="aiui-tp-body">
          <For each={pieces()} keyed={(piece) => piece.key}>
            {(piece) => {
              // One-shot read (hence untrack): a key's KIND never changes,
              // so the row shape is decided once; content stays reactive
              // through the key-scoped memos inside each row.
              const p = untrack(piece);
              return p.item.kind === "shot"
                ? shotRow(p.key)
                : p.item.kind === "app-selection"
                  ? selectionRow(p.key, false)
                  : p.item.kind === "code-selection"
                    ? selectionRow(p.key, true)
                    : p.item.kind === "navigation"
                      ? navRow(p.key)
                      : p.words?.some((w) => w.logprob !== undefined)
                        ? heatRow(p.key)
                        : textRow(p.key);
            }}
          </For>
        </div>
      </Show>
    </details>
  );
}
