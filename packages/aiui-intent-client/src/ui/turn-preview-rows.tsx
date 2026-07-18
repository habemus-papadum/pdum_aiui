/**
 * turn-preview-rows.tsx — the six per-kind row renderers and the kind
 * dispatcher. Each renderer creates reactive nodes AT CALL TIME (the byKey
 * memo, heatRow's per-word alpha memo, textRow's createEffect), so renderRow
 * MUST be called inline in the <For> child body, under that child's owner —
 * never stored and invoked later, which would orphan the memos. The renderers
 * share TurnPreview's state through an explicit RowContext instead of the
 * ambient component closure. The heat-vs-text decision here and the `:w` heat
 * re-key in turn-preview-fold.ts are one cross-file invariant.
 */

import type { Engine } from "@habemus-papadum/aiui-lowering-pipeline";
import { LiveDiffText } from "@habemus-papadum/aiui-viz/modal";
import { createEffect, createMemo, For, Show } from "solid-js";
import type { EditorMode } from "./segment-editor";
import { type Piece, shortRoute } from "./turn-preview-fold";
import type { Peek } from "./turn-preview-peek";

/** The state the row renderers share — TurnPreview's closure made explicit. */
export interface RowContext {
  peek: Peek;
  /** The live item behind a key (a key-scoped memo, so a re-fold updates in place). */
  byKey: (key: string) => () => Piece | undefined;
  engine: () => Engine;
  logprobRange: () => { min: number; max: number } | undefined;
  openEditor: (mode: EditorMode) => void;
}

const heatRow = (ctx: RowContext, key: string) => {
  const current = ctx.byKey(key);
  return (
    <span class="aiui-tp-seg final" data-testid="heat-row">
      <For each={current()?.words ?? []}>
        {(word) => {
          // Its own memo: a <For> child body runs once, untracked — a bare
          // read here would freeze the tint at insert time.
          const alpha = createMemo(() => {
            const range = ctx.logprobRange();
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
                  alpha() > 0.04 ? { background: `rgba(255, 92, 135, ${alpha().toFixed(3)})` } : {}
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
const textRow = (ctx: RowContext, key: string) => {
  const host = document.createElement("span");
  const live = new LiveDiffText(host);
  const current = ctx.byKey(key);
  createEffect(
    () => ({
      text: current()?.item.text ?? "",
      provisional: (current()?.item as { provisional?: boolean } | undefined)?.provisional === true,
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
const shotRow = (ctx: RowContext, key: string) => {
  const current = ctx.byKey(key);
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
          ctx.peek.showImage(wrap, thumb);
        }
      }}
      onMouseLeave={() => ctx.peek.hide()}
    >
      <Show
        when={current()?.item.thumb}
        fallback={<span class="aiui-tp-thumb-chip">📷 {current()?.item.marker}</span>}
      >
        {(src) => <img class="aiui-tp-thumb" src={src()} alt={current()?.item.marker ?? "shot"} />}
      </Show>
      <button
        type="button"
        class="aiui-tp-x"
        title={`remove ${current()?.item.marker ?? "this shot"} from this turn`}
        onClick={(event) => {
          event.stopPropagation();
          ctx.peek.hide();
          const marker = current()?.item.marker;
          if (marker !== undefined) {
            ctx.engine().dropShot(marker);
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
const selectionRow = (ctx: RowContext, key: string, isCode: boolean) => {
  const current = ctx.byKey(key);
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
          ctx.peek.showText(wrap, item.sourceLoc, item.text ?? "");
        }
      }}
      onMouseLeave={() => ctx.peek.hide()}
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
          ctx.peek.hide();
          const marker = current()?.item.marker;
          if (isCode) {
            if (marker !== undefined) {
              ctx.engine().dropCodeSelection(marker);
            }
          } else {
            ctx.engine().appSelectionDrop(marker);
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
const navRow = (ctx: RowContext, key: string) => {
  const current = ctx.byKey(key);
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
          ctx.peek.showText(chip, "navigation", `${item.from ?? "?"}\n→ ${item.to ?? "?"}`);
        }
      }}
      onMouseLeave={() => ctx.peek.hide()}
    >
      ⇢
    </span>
  );
};

/** The tab-switch sibling of {@link navRow}: the ⇥ chip — the user turned to
 * a different tab (distinct from a same-tab navigation). Same discipline. */
const tabRow = (ctx: RowContext, key: string) => {
  const current = ctx.byKey(key);
  let chip: HTMLSpanElement | undefined;
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: hover peek is enhancement only — the title attribute carries the content accessibly
    <span
      class="aiui-tp-chip aiui-tp-nav"
      data-testid="tab-chip"
      ref={(el: HTMLSpanElement) => {
        chip = el;
      }}
      title={`switched tabs ${shortRoute(current()?.item.from)} → ${shortRoute(current()?.item.to)}`}
      onMouseEnter={() => {
        const item = current()?.item;
        if (item !== undefined && chip !== undefined) {
          ctx.peek.showText(chip, "tab switch", `${item.from ?? "?"}\n→ ${item.to ?? "?"}`);
        }
      }}
      onMouseLeave={() => ctx.peek.hide()}
    >
      ⇥
    </span>
  );
};

/**
 * The kind dispatcher: an already-untracked Piece decides its row shape once
 * (kind never changes for a key), and a text row is wrapped as an EDITABLE
 * segment — the hover ✎ or a DOUBLE-CLICK opens the segment editor. Called
 * inline in the <For> child so every reactive node the renderers create is
 * owned by that child.
 */
export function renderRow(ctx: RowContext, piece: Piece) {
  if (piece.item.kind === "shot") {
    return shotRow(ctx, piece.key);
  }
  if (piece.item.kind === "app-selection") {
    return selectionRow(ctx, piece.key, false);
  }
  if (piece.item.kind === "code-selection") {
    return selectionRow(ctx, piece.key, true);
  }
  if (piece.item.kind === "navigation") {
    return navRow(ctx, piece.key);
  }
  if (piece.item.kind === "tab-switch") {
    return tabRow(ctx, piece.key);
  }
  const inner = piece.words?.some((w) => w.logprob !== undefined)
    ? heatRow(ctx, piece.key)
    : textRow(ctx, piece.key);
  const segment = piece.item.segment;
  if (segment === undefined) {
    return inner;
  }
  // A text row is EDITABLE: the hover ✎ or a DOUBLE-CLICK opens the segment
  // editor (one segment at a time — the owner's edit unit; the ✎ stays as the
  // discoverable, accessible path).
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: dblclick is a shortcut — the ✎ button inside is the accessible control
    <span
      class="aiui-tp-wrap aiui-tp-textwrap"
      title="double-click to edit"
      onDblClick={() => ctx.openEditor({ kind: "segment", segment })}
    >
      {inner}
      <button
        type="button"
        class="aiui-tp-x aiui-tp-edit"
        title={`edit segment ${segment} (fix text, delete items, paste)`}
        onClick={() => ctx.openEditor({ kind: "segment", segment })}
      >
        ✎
      </button>
    </span>
  );
}
