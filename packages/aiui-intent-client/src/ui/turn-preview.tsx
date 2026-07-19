/**
 * turn-preview.tsx — the turn preview, with the retired overlay's accumulator
 * UX (owner, 2026-07-14: same functionality, logic living in THIS repo, done
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
 * after attach, then flip). Ported from the retired overlay's
 * multimodal/preview.tsx (git history), whose class-plus-render shape this
 * component replaced.
 *
 * This module is the facade: it keeps the stylesheet, the reactive shells
 * (threadOpen/pieces/logprobRange/lints), and the JSX tree. The pieces come
 * from `turn-preview-fold.ts` (the pure fold + keying), the six per-kind row
 * renderers from `turn-preview-rows.tsx` (over an explicit RowContext), and
 * the hover peek from `turn-preview-peek.ts`.
 */

import { createMemo, createSignal, For, Show, untrack } from "solid-js";
import type { ChannelLanes } from "../lanes";
import { type EditorMode, SEGMENT_EDITOR_STYLES, SegmentEditor } from "./segment-editor";
import { buildPieces, logprobRangeOf, type Piece } from "./turn-preview-fold";
import { createPeek } from "./turn-preview-peek";
import { type RowContext, renderRow } from "./turn-preview-rows";

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
  /* Chips + thumbs — the retired overlay's visual language, verbatim: amber = pixels,
     blue family = selections, gray = boundaries; substance rides the peek. */
  .aiui-tp-wrap { position: relative; display: inline-block; margin: 0 4px; vertical-align: middle; }
  /* Respect the capture's TRUE aspect ratio, just bounded: max-width/max-height
     scale the image down to fit while preserving its shape, so the amber border
     hugs the real image (a 16:9 reads as 16:9, a portrait as a portrait). A
     fixed object-fit: cover tile was compact but LIED — every capture became the
     same rectangle, edges cropped away. The max-width keeps even an ultrawide
     from running the pane; the hover peek carries the detail. */
  .aiui-tp-thumb { max-height: 38px; max-width: 72px; border-radius: 4px;
    border: 2px solid #ffd166; vertical-align: middle; display: block; }
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
     absolutely-positioned child would clip (the retired overlay's measured lesson). */
  /* The peek is the same capture at its NATURAL aspect within a bigger box — the
     same shape as the thumbnail (both just show the real image), so the hover is
     a faithful magnification, not a re-crop. Its box size is only known once the
     image decodes, which is why showImage re-measures on load. */
  .aiui-tp-peek-img { position: fixed; z-index: 2147483644; max-width: min(480px, 60vw);
    max-height: 60vh; border: 2px solid #ffd166; border-radius: 8px; background: #0f1117;
    box-shadow: 0 8px 30px rgba(0, 0, 0, 0.55); pointer-events: none; }
  .aiui-tp-peek { position: fixed; z-index: 2147483644; max-width: min(480px, 60vw);
    border: 1px solid #8ab4f8; border-radius: 8px; background: #0f1117;
    box-shadow: 0 8px 30px rgba(0, 0, 0, 0.55); pointer-events: none;
    padding: 8px 10px; font: 12px/1.5 ui-sans-serif, system-ui, -apple-system, sans-serif; }
  .aiui-tp-peek-loc { color: #9aa0aa; font-size: 11px; margin-bottom: 4px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .aiui-tp-peek-text { color: #e8e8ea; white-space: pre-wrap; word-break: break-word;
    display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 6; overflow: hidden; }
  .aiui-tp-textwrap { position: relative; display: inline; }
  .aiui-tp-edit { color: #8ab4f8; }
  .aiui-tp-add { cursor: pointer; background: transparent; font: inherit; color: inherit;
    opacity: 0.7; margin-top: 4px; }
  .aiui-tp-add:hover { opacity: 1; }
  /* The linter's 💡 advice — chips below the flow, per-turn, locally dismissible. */
  .aiui-tp-lints { margin-top: 6px; display: flex; flex-wrap: wrap; gap: 4px; }
  .aiui-tp-lint { color: #ffd166; border-color: #5a4a24; position: relative;
    padding-right: 22px; white-space: normal; }
  .aiui-tp-lint .aiui-tp-x { display: flex; position: absolute; right: 2px; top: 50%;
    transform: translateY(-50%); }
`
  // The segment editor mounts from this pane; its styles travel with ours.
  .concat(SEGMENT_EDITOR_STYLES);

// The fold, row keying, and the Piece type live in turn-preview-fold.ts;
// shortRoute is re-exported so this module's historical surface is unchanged
// (the nav/tab rows use it too).
export { shortRoute } from "./turn-preview-fold";

/**
 * The turn preview: what the open turn will lower to — composeIntent (the
 * SAME first IR pass the channel runs) over the current thread's events, so
 * what you see is literally what will lower. Per-turn by construction.
 */
export function TurnPreview(props: { lanes: ChannelLanes }) {
  const peek = createPeek();
  const engine = () => props.lanes.engine;
  /** The segment editor's door (undefined = closed). */
  const [editing, setEditing] = createSignal<EditorMode | undefined>(undefined, {
    ownedWrite: true,
  });
  /** `threadOpen` is a plain engine property; every change to it is an engine
   * EVENT, so reading it under the cursor is what makes it reactive. */
  const threadOpen = createMemo(() => {
    void props.lanes.eventsRev();
    return engine().threadOpen;
  });

  const pieces = createMemo<Piece[]>(() => {
    const events = props.lanes.threadEvents(); // subscribes to the cursor
    // THE reset rule (the retired overlay's): the accumulator is per-turn — no open
    // thread, no pieces. Abandon/send empties the preview instead of letting
    // between-turn events (navigations above all) haunt a closed turn.
    if (!threadOpen()) {
      return [];
    }
    return buildPieces(events);
  });

  /** The turn-wide logprob range: heat normalizes against the turn's own
   * confidence distribution (absolute scales wash out across vendors). */
  const logprobRange = createMemo(() => logprobRangeOf(pieces()));

  /**
   * The linter's 💡 advice (the retired overlay's lint chips, ported): notes
   * ride the thread's raw events — the COMPILER ignores them, so they never
   * become composed items; the preview reads them directly. Dismissal is
   * LOCAL (owner): a dismissed note's `at` lands in a signal-held set that
   * resets with the turn — nothing goes back to the channel.
   */
  const [dismissedLints, setDismissedLints] = createSignal<ReadonlySet<number>>(new Set<number>(), {
    ownedWrite: true,
  });
  const lints = createMemo(() => {
    if (!threadOpen()) {
      if (untrack(dismissedLints).size > 0) {
        setDismissedLints(new Set<number>()); // per-turn, like everything here
      }
      return [];
    }
    const dismissed = dismissedLints();
    // The oracle's replies ride the same chip rail (🔮 vs 💡): both are
    // advisory record events the compiler ignores; only the voice differs.
    return props.lanes
      .threadEvents()
      .filter(
        (event): event is Extract<typeof event, { type: "linter-note" | "oracle-said" }> =>
          event.type === "linter-note" || event.type === "oracle-said",
      )
      .filter((event) => !dismissed.has(event.at));
  });

  /** The live item behind a key — rows read content through this so a
   * re-fold (a refinement, a late thumb) updates in place. */
  const byKey = (key: string) => createMemo(() => pieces().find((p) => p.key === key));

  // The rows share this context instead of the component closure; renderRow
  // creates their reactive nodes at call time, so it is invoked INLINE in the
  // <For> child body below (never stored and called later).
  const rowCtx: RowContext = {
    peek,
    byKey,
    engine,
    logprobRange,
    openEditor: (mode) => setEditing(mode),
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
              // through the key-scoped memos inside each row. renderRow runs
              // INLINE here so its reactive nodes are owned by this child.
              const p = untrack(piece);
              return renderRow(rowCtx, p);
            }}
          </For>
        </div>
      </Show>
      <Show when={lints().length > 0}>
        <div class="aiui-tp-lints" data-testid="lint-chips">
          <For each={lints()} keyed={(note) => note.at}>
            {(note) => {
              const n = untrack(note);
              return (
                <span class="aiui-tp-chip aiui-tp-lint" title={n.text}>
                  {n.type === "oracle-said" ? "🔮" : "💡"}{" "}
                  {n.text.length > 60 ? `${n.text.slice(0, 57)}…` : n.text}
                  <button
                    type="button"
                    class="aiui-tp-x"
                    title="dismiss this advice (local — the turn is unchanged)"
                    onClick={() => setDismissedLints(new Set([...dismissedLints(), n.at]))}
                  >
                    ✕
                  </button>
                </span>
              );
            }}
          </For>
        </div>
      </Show>
      <Show when={threadOpen()}>
        <button
          type="button"
          class="aiui-tp-chip aiui-tp-add"
          data-testid="add-to-turn"
          title="add text or images to the end of the turn (paste works)"
          onClick={() => setEditing({ kind: "append" })}
        >
          ＋ add
        </button>
      </Show>
      <Show when={editing()} keyed>
        {(mode) => (
          <SegmentEditor lanes={props.lanes} mode={mode} onClose={() => setEditing(undefined)} />
        )}
      </Show>
    </details>
  );
}
