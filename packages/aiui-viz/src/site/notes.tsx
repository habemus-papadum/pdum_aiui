/**
 * notes.tsx — the notes layer, once. A NOTE is arbitrary JSX anchored to a
 * piece of something another library drew — a term's glyphs in a KaTeX
 * equation, a node in a Mermaid diagram — centered on the piece's measured
 * box, on the side the author chose, with a leader line back to it. Notes
 * that would overlap are pushed apart left to right ({@link resolveNoteShifts});
 * a pushed note keeps its leader on the piece it belongs to. Each note learns
 * its piece's width (`--aiui-note-w`), for a stylesheet that confines notes to
 * their anchors. Placement is "reasonable rules", not a guarantee: notes are
 * marginalia, and a page that needs more than one family of them shows one at
 * a time (a lens).
 *
 * ```tsx
 * <NoteLayer layout="margin" side="below" host={() => math}
 *   anchorOf={(id) => spans.get(id)} notes={specs()} version={html()} />
 * ```
 *
 * **Two layouts, one layer.** `margin`: an in-flow strip the consumer places
 * above or below its host — a one-cell grid, so it sizes to its tallest note
 * without a second measurement; notes sit at their anchor's x, the leader
 * runs from the strip's edge to the anchor's near edge (`--aiui-note-leader`).
 * RichTeX uses two, one per side, around the equation. `overlay`: an absolute
 * layer over the host; each note sits at its anchor point (below, above, left
 * or right of the box) with a standoff (`--aiui-note-gap`). Mermaid uses one
 * over the diagram. The collision pass runs per row: the one row of a margin
 * strip; in an overlay, the above/below notes whose anchors share a band of
 * y (a diagram's ranks), so notes on different ranks never push each other.
 *
 * **Measuring.** Anchors are looked up by id at measure time (`anchorOf`),
 * because the consumer's elements are replaced on every re-render; boxes are
 * read in one animation frame after anything that could move them: the
 * consumer's `version` (its rendered markup's key), the host's size and
 * every note's own size through the resize seam (`elementWidth`,
 * `elementHeight`: one shared ResizeObserver), and the web fonts landing.
 *
 * **What stays component-specific.** Which pieces have notes and what the
 * note is (the consumer's props); what the anchor elements are. The LOOK of a
 * note is the skin's (`aiui-notes`, `aiui-note`, `data-active`;
 * aiui-design dresses them); this module owns positions only.
 */
import type { JSX } from "@solidjs/web";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  getOwner,
  onCleanup,
  runWithOwner,
  Show,
} from "solid-js";
import { elementHeight, elementWidth } from "../viewport";
import { ensureStyles } from "./styles";

export type NoteSide = "below" | "above" | "left" | "right";

/** One note, as the consumer declares it. Fields may be getters (reactive). */
export interface NoteSpec {
  /** The anchor's id — `data-for`, the collision key, `anchorOf`'s argument. */
  id: string;
  /** Which side of the anchor. Default `below`. A margin strip shows only its side's notes. */
  side?: NoteSide;
  /** Marks the note `data-active="true"` (a linked highlight). */
  active?: boolean;
  note: JSX.Element;
}

/** An anchor's box, in CSS px relative to the host's top-left. */
export interface NoteBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** A note as the collision pass sees it: where its anchor is, how wide it rendered. */
export interface NoteItem {
  id: string;
  /** The anchor x (the piece's horizontal center), host px. */
  anchor: number;
  width: number;
}

/**
 * Push notes apart, left to right: each note keeps its anchor unless it
 * would overlap the note before it, in which case it moves right by the
 * least that clears it. Returns each note's horizontal shift from its
 * anchor (0 for an undisturbed note). Pure; one pass over one row.
 */
export function resolveNoteShifts(items: readonly NoteItem[], gap = 8): Map<string, number> {
  const sorted = [...items].sort((a, b) => a.anchor - b.anchor);
  const out = new Map<string, number>();
  let prevRight = Number.NEGATIVE_INFINITY;
  for (const it of sorted) {
    let left = it.anchor - it.width / 2;
    if (left < prevRight + gap) left = prevRight + gap;
    out.set(it.id, left + it.width / 2 - it.anchor);
    prevRight = left + it.width;
  }
  return out;
}

/** Where a note of `side` attaches to a box: the box's edge midpoint. */
export function anchorPoint(b: NoteBox, side: NoteSide): { x: number; y: number } {
  switch (side) {
    case "above":
      return { x: b.left + b.width / 2, y: b.top };
    case "left":
      return { x: b.left, y: b.top + b.height / 2 };
    case "right":
      return { x: b.left + b.width, y: b.top + b.height / 2 };
    default:
      return { x: b.left + b.width / 2, y: b.top + b.height };
  }
}

interface Measured extends NoteItem {
  side: NoteSide;
  /** The anchor point's y and the note's height: a band of y the note occupies. */
  y: number;
  height: number;
}

/**
 * Overlay rows: above/below notes whose anchor y's fall within one note height
 * of each other collide; left/right notes never do. Pure; exported for tests.
 */
export function overlayRows(items: readonly Measured[]): Measured[][] {
  const rows: Measured[][] = [];
  for (const side of ["below", "above"] as const) {
    const mine = items.filter((it) => it.side === side).sort((a, b) => a.y - b.y);
    let row: Measured[] = [];
    let rowY = Number.NEGATIVE_INFINITY;
    for (const it of mine) {
      if (row.length > 0 && it.y - rowY > Math.max(it.height, row[0]?.height ?? 0)) {
        rows.push(row);
        row = [];
      }
      if (row.length === 0) rowY = it.y;
      row.push(it);
    }
    if (row.length > 0) rows.push(row);
  }
  return rows;
}

export interface NoteLayerProps {
  /** The element every anchor is measured against (boxes in its CSS px); its
   * size is observed. An accessor, because refs bind after the first compute. */
  host: () => HTMLElement | undefined;
  /** The element a note annotates, by id, looked up at measure time. An
   * anchor that is not there hides its note. */
  anchorOf: (id: string) => Element | undefined;
  notes: readonly NoteSpec[];
  /** `margin`: an in-flow strip for one `side`, placed by the consumer above
   * or below its host. `overlay`: an absolute layer over the host, all sides. */
  layout: "margin" | "overlay";
  /** The margin strip's side. Default `below`. */
  side?: "above" | "below";
  /** Any change re-measures the anchors: pass the rendered markup's key. */
  version?: unknown;
  /** Minimum px between two notes in a row. Default 8. */
  spacing?: number;
  /** Extra class(es) on the layer, after `aiui-notes`. */
  class?: string;
}

// ── structural CSS (positions only; the look is the consumer's) ─────────────

export const NOTES_STYLES = `
.aiui-notes-margin { display: grid; width: 100%; }
.aiui-notes-margin.aiui-notes-below { padding-top: var(--aiui-note-gap, 16px); }
.aiui-notes-margin.aiui-notes-above { padding-bottom: var(--aiui-note-gap, 16px); align-items: end; }
.aiui-notes-margin > .aiui-note { grid-area: 1 / 1; justify-self: start; position: relative;
  margin-left: calc((var(--aiui-note-x, 0) + var(--aiui-note-shift, 0)) * 1px);
  transform: translateX(-50%); }
.aiui-notes-margin > .aiui-note::before { content: ""; position: absolute; width: 0;
  left: calc(50% - var(--aiui-note-shift, 0) * 1px);
  border-left: 1px solid var(--aiui-note-leader-color, currentColor); opacity: 0.5;
  height: calc(var(--aiui-note-leader, 0) * 1px + var(--aiui-note-gap, 16px) - 3px); }
.aiui-notes-below > .aiui-note::before { bottom: 100%; }
.aiui-notes-above > .aiui-note::before { top: 100%; }
.aiui-notes-overlay { position: absolute; inset: 0; pointer-events: none; }
.aiui-notes-overlay > .aiui-note { position: absolute; pointer-events: auto;
  left: calc((var(--aiui-note-x, 0) + var(--aiui-note-shift, 0)) * 1px);
  top: calc(var(--aiui-note-y, 0) * 1px); }
.aiui-notes-overlay > .aiui-note-below { transform: translate(-50%, var(--aiui-note-gap, 6px)); }
.aiui-notes-overlay > .aiui-note-above { transform: translate(-50%, calc(-100% - var(--aiui-note-gap, 6px))); }
.aiui-notes-overlay > .aiui-note-right { transform: translate(var(--aiui-note-gap, 6px), -50%); }
.aiui-notes-overlay > .aiui-note-left { transform: translate(calc(-100% - var(--aiui-note-gap, 6px)), -50%); }
.aiui-notes-overlay > .aiui-note-below::before, .aiui-notes-overlay > .aiui-note-above::before {
  content: ""; position: absolute; width: 0; left: calc(50% - var(--aiui-note-shift, 0) * 1px);
  border-left: 1px solid var(--aiui-note-leader-color, currentColor); opacity: 0.5;
  height: calc(var(--aiui-note-gap, 6px) - 2px); }
.aiui-notes-overlay > .aiui-note-below::before { bottom: 100%; }
.aiui-notes-overlay > .aiui-note-above::before { top: 100%; }
`;
const STYLE_MARK = "data-aiui-notes";

const sideOf = (n: NoteSpec): NoteSide => n.side ?? "below";

export function NoteLayer(props: NoteLayerProps): JSX.Element {
  ensureStyles(STYLE_MARK, NOTES_STYLES);
  const layout = (): "margin" | "overlay" => props.layout;
  const stripSide = (): "above" | "below" => props.side ?? "below";
  const shown = createMemo(
    () =>
      layout() === "margin" ? props.notes.filter((n) => sideOf(n) === stripSide()) : props.notes,
    { equals: (a, b) => a.length === b.length && a.every((note, i) => note === b[i]) },
  );

  let layer: HTMLElement | undefined;
  const [boxes, setBoxes] = createSignal<ReadonlyMap<string, NoteBox>>(new Map());
  const [shifts, setShifts] = createSignal<ReadonlyMap<string, number>>(new Map());
  const [hostHeight, setHostHeight] = createSignal(0);

  // ── geometry ──────────────────────────────────────────────────────────────
  // Read in a rAF callback — an imperative boundary, so the writes are plain.
  const measure = (): void => {
    const host = props.host();
    if (host === undefined || !host.isConnected || layer === undefined) return;
    const h = host.getBoundingClientRect();
    const specs = new Map<string, NoteSpec>();
    for (const n of shown()) specs.set(n.id, n);
    const next = new Map<string, NoteBox>();
    const items: Measured[] = [];
    for (const el of layer.querySelectorAll<HTMLElement>(":scope > .aiui-note")) {
      const id = el.getAttribute("data-for");
      const spec = id === null ? undefined : specs.get(id);
      const target = id === null ? undefined : props.anchorOf(id);
      if (id === null || spec === undefined || target === undefined) continue;
      const b = target.getBoundingClientRect();
      const box: NoteBox = {
        left: b.left - h.left,
        top: b.top - h.top,
        width: b.width,
        height: b.height,
      };
      next.set(id, box);
      const side = sideOf(spec);
      const p = anchorPoint(box, side);
      const r = el.getBoundingClientRect();
      items.push({ id, side, anchor: p.x, y: p.y, width: r.width, height: r.height });
    }
    setBoxes(next);
    setHostHeight(h.height);
    const rows = layout() === "margin" ? [items] : overlayRows(items);
    const pushed = new Map<string, number>();
    for (const row of rows) {
      for (const [id, dx] of resolveNoteShifts(row, props.spacing ?? 8)) pushed.set(id, dx);
    }
    setShifts(pushed);
  };
  let raf: number | undefined;
  const schedule = (): void => {
    if (typeof requestAnimationFrame !== "function") return;
    if (raf !== undefined) cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      raf = undefined;
      measure();
    });
  };
  onCleanup(() => {
    if (raf !== undefined) cancelAnimationFrame(raf);
  });
  if (typeof document !== "undefined" && "fonts" in document) {
    document.fonts.ready.then(schedule, () => {});
  }

  // Anything that can move an anchor re-measures: the consumer's version,
  // the set of notes, the host's box. (Each note watches its own box below.)
  createEffect(
    () => {
      const host = props.host();
      return [
        props.version,
        shown(),
        host === undefined ? 0 : elementWidth(host)(),
        host === undefined ? 0 : elementHeight(host)(),
      ];
    },
    () => schedule(),
  );

  const layerClass = (): string => {
    const base = `aiui-notes aiui-notes-${layout()}`;
    const side = layout() === "margin" ? ` aiui-notes-${stripSide()}` : "";
    return props.class === undefined ? `${base}${side}` : `${base}${side} ${props.class}`;
  };

  return (
    <Show when={shown().length > 0}>
      <div
        class={layerClass()}
        ref={(el) => {
          layer = el;
        }}
      >
        <For each={shown()}>
          {(n) => {
            const box = () => boxes().get(n.id);
            const at = () => {
              const b = box();
              return b === undefined ? undefined : anchorPoint(b, sideOf(n));
            };
            // Margin strips: from the strip's edge to the anchor's near edge;
            // the stylesheet adds the standoff.
            const leader = () => {
              const b = box();
              if (b === undefined || layout() !== "margin") return 0;
              const toEdge = stripSide() === "below" ? hostHeight() - (b.top + b.height) : b.top;
              return Math.max(0, toEdge);
            };
            // A note that grows (a number gaining a digit) re-runs the pass:
            // its box is watched from the moment its element exists. Refs run
            // with no owner, so the effect is created under the row's, where
            // it is disposed with the row.
            const owner = getOwner();
            const watch = (el: HTMLElement): void =>
              runWithOwner(owner, () =>
                createEffect(
                  () => [elementWidth(el)(), elementHeight(el)()],
                  () => schedule(),
                ),
              );
            return (
              <div
                class={`aiui-note aiui-note-${sideOf(n)}`}
                data-for={n.id}
                data-active={n.active === true ? "true" : undefined}
                style={{
                  "--aiui-note-x": String(at()?.x ?? 0),
                  "--aiui-note-y": String(at()?.y ?? 0),
                  "--aiui-note-w": String(box()?.width ?? 0),
                  "--aiui-note-shift": String(shifts().get(n.id) ?? 0),
                  "--aiui-note-leader": String(leader()),
                  visibility: box() === undefined ? "hidden" : undefined,
                }}
                ref={watch}
              >
                {n.note}
              </div>
            );
          }}
        </For>
      </div>
    </Show>
  );
}
