/**
 * rich-tex.tsx — an equation built from PIECES, each piece addressable after
 * KaTeX has drawn it.
 *
 * `TeX` takes one string and renders one opaque block. `RichTeX` takes
 * CHILDREN — TeX strings and `<Term>`s, nested freely — joins them into one
 * equation, and keeps a map from every `<Term>` to the glyphs KaTeX produced
 * for it. That map is what lets a term be styled, recolored, hovered,
 * clicked, DRAGGED (a term bound to a control is a knob), and ANNOTATED (a
 * note placed under or over exactly that piece of the equation) —
 * reactively, while the equation stays one typeset whole.
 *
 * ```tsx
 * <RichTeX display>
 *   {"L(\\theta) = "}
 *   <Term id="policy" color={hue("policy")} note={<Share of="policy" />}>
 *     {"\\mathbb{E}\\big[\\min(r\\hat A, \\mathrm{clip}(r,1-\\epsilon,1+\\epsilon)\\hat A)\\big]"}
 *   </Term>
 *   {" + "}
 *   <Term id="kl" color={hue("kl")} note={<Share of="kl" />}>
 *     <Term control={beta}>{"\\beta"}</Term>
 *     {"\\, D_{KL}"}
 *   </Term>
 * </RichTeX>
 * ```
 *
 * **How the map works — markers at assembly, never recovery afterwards.**
 * KaTeX's own HTML extension gives every group a handle: `\htmlData{k=v}{…}`
 * renders its body inside `<span class="enclosing" data-k="v">`, and KaTeX
 * looks THROUGH `enclosing` spans when it computes inter-atom spacing and
 * binary-operator cancellation, so the wrapper changes no layout (pinned by
 * rich-tex.test.tsx: the atom-and-spacing skeleton of a marked render equals
 * the plain render's). Each `<Term>` becomes `\htmlData{aiui-term=ID}{body}`
 * in the string handed to KaTeX; after the render, the term's span is found
 * by its attribute. The alternative — recovering positions from KaTeX's parse
 * tree — is a dead end: its source locations are incomplete (a fraction node
 * carries none), and the DOM tree never references the parse tree at all.
 *
 * Two consequences a consumer must know:
 *  - **A term is a balanced TeX group.** `\left(` in one term and `\right)` in
 *    another is a parse error (it renders red, like any KaTeX error; the page
 *    is never blanked). Sized delimiters that stand alone (`\big(`, `\Big)`)
 *    split fine.
 *  - **The marker body is NOT wrapped in extra braces.** `{…}` would make an
 *    ordgroup — a single `mord` to KaTeX — and `a{+b}` loses the spaces around
 *    `+`. `\htmlData`'s own argument braces are the group; nothing is added.
 *
 * **Two reactive levels.** A change to any TeX string re-assembles, re-renders
 * (one `renderToString`, sub-millisecond for an equation) and re-finds the
 * term spans. A change to a term's DECORATION (`color`, `class`, `active`)
 * touches only that span's attributes — the KaTeX DOM stays put, so CSS
 * transitions on a term run. One effect carries both: its compute tracks the
 * HTML and every decoration; its handler compares the HTML string first.
 *
 * **Knobs.** A term with `control` is a numeric control's symbol in the
 * equation — the scrub pill's idea (`ControlScrub`), for mathematics. The
 * symbol stays symbolic; hover or focus it and a readout shows the current
 * value; press and drag horizontally to move it (a `span` px drag crosses
 * the control's whole declared range, so every knob feels the same); arrow
 * keys step it when focused. Writes go through the control's own validation,
 * so bounds and snapping are declared once. The span carries
 * `data-control="<name>"`, the attribution contract every control widget
 * keeps, so `locate` and `selection` resolve a knob to its control and the
 * agent's `set` tool moves what the user drags. One control may back several
 * knobs (ε appears twice in a clip); give those explicit ids.
 *
 * **Notes.** A term's `note` is arbitrary JSX rendered in a layer under (or
 * over) the equation, centered on the term's glyphs, with a leader line up to
 * them. Positions come from `getBoundingClientRect` after each render and on
 * every resize/font load; the layer is a one-cell grid, so it sizes to its
 * tallest note without a second measurement. Notes that would overlap are
 * pushed apart left to right ({@link resolveNoteShifts}); a pushed note keeps
 * its leader on the glyphs it belongs to. Each note also learns its term's
 * width (`--aiui-rtx-w`), for a stylesheet that confines notes to their
 * terms. Notes render for display math only — an inline equation has no
 * room for a layer. Placement is "reasonable rules", not a guarantee: notes
 * are marginalia, and a page that needs more than one family of them shows
 * one at a time (a lens). One row per side today. The intended extension,
 * when a page needs it, is ROWS: a note names its row (`row={2}`), rows stack
 * outward from the glyphs on each side — one above, one below, then more —
 * each row running its own collision pass, leaders lengthening through the
 * rows between. The layers are already one-cell grids per side; a row is one
 * more grid cell and a longer leader. Not built until a page asks.
 *
 * **The agent surface.** The root carries `data-tex` with the CLEAN joined
 * source (no markers), so `read-page` emits the equation as the author wrote
 * it and `selection` recovers it; each term's span carries its own `data-tex`
 * (and `data-aiui-term`), so a selection inside one term reports that term,
 * and a copy of it puts that term's TeX on the clipboard (math-selection.ts).
 * The KaTeX MathML annotation holds the MARKED string — that is why the clean
 * stamp is authoritative, as `page-text.ts` already prefers.
 *
 * KaTeX settings: `trust` admits exactly `\htmlData` with exactly our key —
 * a term's TeX cannot smuggle a class, id or style attribute in; `strict`
 * silences only the `htmlExtension` notice (the HTML extension is "LaTeX-
 * incompatible" by KaTeX's definition, and that is the point here).
 */
import type { JSX } from "@solidjs/web";
import katex from "katex";
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import type { ControlBox } from "../control";
import { withUnit } from "../control-widgets";
import { MATH_TERM_ATTR } from "../math-selection";
import "katex/dist/katex.min.css";

/** The attribute a term's rendered span carries: `data-aiui-term="<id>"`. */
export const TERM_ATTR = MATH_TERM_ATTR;
const TERM_KEY = "aiui-term";

export interface TermProps {
  /** Stable identity — the `data-aiui-term` value and the note's key. Letters,
   * digits, `_ . : -` only (the marker syntax reserves `,` `=` `}`). Required
   * unless `control` is given, when it defaults to the control's name. */
  id?: string;
  /** The term's TeX: strings and nested `<Term>`s. */
  children?: JSX.Element;
  /** CSS color for the glyphs (KaTeX draws in `currentColor`). Reactive. */
  color?: string;
  /** Extra class(es) on the term's span, after `aiui-rtx-term`. Reactive. */
  class?: string;
  /** Marks the span `data-active="true"` (a linked highlight). Reactive. */
  active?: boolean;
  /** Annotation JSX, rendered in the notes layer anchored to this term. */
  note?: JSX.Element;
  /** Which side of the equation the note sits on. Default `below`. */
  place?: "below" | "above";
  /** Pointer enters/leaves the term's glyphs (nested terms notify every
   * enclosing term too). */
  onHover?: (hovering: boolean) => void;
  /** A click on the term's glyphs. */
  onClick?: () => void;
  /** Makes the term a KNOB: the symbol of this numeric control. Hover for the
   * value, drag to change it, arrow keys when focused (see the module doc). */
  control?: ControlBox<number>;
  /** Readout formatter for a knob; defaults to the value at the step's
   * precision plus the control's unit. */
  format?: (value: number) => string;
  /** Pixels of horizontal drag that cross a knob's declared range. Default 240. */
  span?: number;
}

export interface RichTeXProps {
  /** Display (block, centered, notes allowed) or inline. Default inline. */
  display?: boolean;
  /** Extra class(es) on the root, after `math-display aiui-rtx` (or the
   * inline pair). */
  class?: string;
  children: JSX.Element;
}

const TERM = Symbol("aiui-rich-tex-term");
interface TermNode {
  [TERM]: true;
  props: TermProps;
}
const isTerm = (v: unknown): v is TermNode =>
  typeof v === "object" && v !== null && (v as Record<symbol, unknown>)[TERM] === true;

/**
 * A piece of a `RichTeX` equation. Returns a DESCRIPTOR, not DOM — the parent
 * assembles the descriptors into one string. Rendering a `<Term>` anywhere
 * else is a mistake the parent reports.
 */
export function Term(props: TermProps): JSX.Element {
  const node: TermNode = { [TERM]: true, props };
  return node as unknown as JSX.Element;
}

/** One `<Term>` as the assembler found it, in document order (nested terms
 * follow their parent). */
export interface AssembledTerm {
  id: string;
  /** The term's own clean TeX (its pieces joined, markers of nested terms
   * removed). */
  tex: string;
  props: TermProps;
}

export interface Assembled {
  /** The equation as authored — what `data-tex` carries. */
  clean: string;
  /** The equation with `\htmlData` markers — what KaTeX renders. */
  marked: string;
  terms: AssembledTerm[];
  /** A structural problem (a bad id, a duplicate, a non-TeX child). Rendered
   * in place of the equation; never thrown. */
  error?: string;
}

const ID_OK = /^[A-Za-z0-9_.:-]+$/;

/** A knob's default id: its control's name, with the scope separator made legal. */
const knobId = (name: string): string => name.replace(/[^A-Za-z0-9_.:-]/g, ".");

/**
 * Join children into the clean and the marked equation. Pure: exported for
 * tests and for anything that wants the strings without rendering.
 * Pieces are trimmed and joined with single spaces, so `"\\alpha"` followed
 * by `"x"` stays two tokens (math-mode spaces are free).
 */
export function assembleTeX(children: unknown): Assembled {
  const terms: AssembledTerm[] = [];
  const seen = new Set<string>();
  let error: string | undefined;

  function walk(value: unknown, clean: string[], marked: string[]): void {
    if (value === null || value === undefined || typeof value === "boolean") return;
    if (typeof value === "string" || typeof value === "number") {
      // Trimmed: math-mode whitespace is insignificant, and a piece written
      // as " + " must not double the join space.
      const s = String(value).trim();
      if (s === "") return;
      clean.push(s);
      marked.push(s);
      return;
    }
    if (typeof value === "function") {
      walk((value as () => unknown)(), clean, marked);
      return;
    }
    if (Array.isArray(value)) {
      for (const v of value) walk(v, clean, marked);
      return;
    }
    if (isTerm(value)) {
      const id =
        value.props.id ??
        (value.props.control !== undefined ? knobId(value.props.control.name) : undefined);
      if (id === undefined) {
        error ??= "RichTeX: a <Term> needs an id (or a control, whose name becomes its id)";
        return;
      }
      if (!ID_OK.test(id)) {
        error ??= `RichTeX: term id "${id}" — use letters, digits, _ . : - only`;
        return;
      }
      if (seen.has(id)) {
        error ??= `RichTeX: duplicate term id "${id}"`;
        return;
      }
      seen.add(id);
      // Reserve the slot: a term precedes the terms nested inside it.
      const entry: AssembledTerm = { id, tex: "", props: value.props };
      terms.push(entry);
      const innerClean: string[] = [];
      const innerMarked: string[] = [];
      walk(value.props.children, innerClean, innerMarked);
      entry.tex = innerClean.join(" ");
      clean.push(entry.tex);
      marked.push(`\\htmlData{${TERM_KEY}=${id}}{${innerMarked.join(" ")}}`);
      return;
    }
    error ??= "RichTeX: children must be TeX strings or <Term>s (got a DOM node or object)";
  }

  const clean: string[] = [];
  const marked: string[] = [];
  walk(children, clean, marked);
  return { clean: clean.join(" "), marked: marked.join(" "), terms, error };
}

/** The KaTeX settings — see the module doc. `displayMode` is added per call. */
const KATEX = {
  throwOnError: false,
  trust: (ctx: { command: string; attributes?: Record<string, string> }): boolean =>
    ctx.command === "\\htmlData" &&
    ctx.attributes !== undefined &&
    Object.keys(ctx.attributes).every((k) => k === `data-${TERM_KEY}`),
  strict: (code: string): "ignore" | "warn" => (code === "htmlExtension" ? "ignore" : "warn"),
};

/** Render the marked equation. Exported so a fidelity check can render the
 * same string with the same settings. */
export function renderMarked(marked: string, display: boolean): string {
  return katex.renderToString(marked, { ...KATEX, displayMode: display });
}

/** A term's glyph box, in CSS px relative to the math host's top-left. */
export interface TermBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** A note as the layout sees it: where its term's glyphs are centered, how wide it rendered. */
export interface NoteItem {
  id: string;
  /** The anchor x (the term's horizontal center), host px. */
  anchor: number;
  width: number;
}

/**
 * Push notes apart, left to right: each note keeps its anchor unless it
 * would overlap the note before it, in which case it moves right by the
 * least that clears it. Returns each note's horizontal shift from its
 * anchor (0 for an undisturbed note). Pure; one pass over one row — when
 * notes gain rows (see the module doc), each row runs its own pass.
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

/** The knob readout's default formatter: the step's precision, then the unit. */
function formatKnob(value: number, meta: ControlBox<number>["meta"]): string {
  const step = meta.step;
  const shown =
    step !== undefined && step > 0 && step < 1
      ? value.toFixed(Math.min(6, Math.max(0, Math.ceil(-Math.log10(step)))))
      : String(value);
  return withUnit(shown, meta.unit);
}

/** Value units per pixel of drag — the scrub pill's rule. */
function perPxOf(control: ControlBox<number>, span: number | undefined): number {
  const { min, max, step } = control.meta;
  const px = span ?? 240;
  if (min !== undefined && max !== undefined && max > min) return (max - min) / px;
  return step ?? 1;
}

/** One keyboard step of a knob: its step, else a hundredth of its range, else 1. */
function keyStepOf(control: ControlBox<number>): number {
  const { min, max, step } = control.meta;
  if (step !== undefined && step > 0) return step;
  if (min !== undefined && max !== undefined && max > min) return (max - min) / 100;
  return 1;
}

const NOTE_GAP = 8;

// ── structural CSS (positions only; the look is the consumer's) ─────────────

export const RICH_TEX_STYLES = `
.aiui-rtx { position: relative; }
.aiui-rtx-stage { position: relative; }
.aiui-rtx-math { display: block; }
.aiui-rtx-inline > .aiui-rtx-stage, .aiui-rtx-inline .aiui-rtx-math { display: inline; }
.aiui-rtx .katex-display { margin: 0; }
.aiui-rtx-knob { cursor: ew-resize; touch-action: none; outline: none; }
.aiui-rtx-readout { position: fixed; z-index: 10; pointer-events: none; white-space: nowrap;
  transform: translate(-50%, calc(-100% - var(--aiui-rtx-readout-gap, 6px))); }
.aiui-rtx-notes { display: grid; width: 100%; }
.aiui-rtx-notes-below { padding-top: var(--aiui-rtx-gap, 16px); }
.aiui-rtx-notes-above { padding-bottom: var(--aiui-rtx-gap, 16px); align-items: end; }
.aiui-rtx-note { grid-area: 1 / 1; justify-self: start; position: relative;
  margin-left: calc((var(--aiui-rtx-x, 0) + var(--aiui-rtx-shift, 0)) * 1px);
  transform: translateX(-50%); }
.aiui-rtx-note::before { content: ""; position: absolute;
  left: calc(50% - var(--aiui-rtx-shift, 0) * 1px); width: 0;
  border-left: 1px solid var(--aiui-rtx-leader, currentColor); opacity: 0.5;
  height: calc(var(--aiui-rtx-leader-len, 0) * 1px + var(--aiui-rtx-gap, 16px) - 3px); }
.aiui-rtx-notes-below .aiui-rtx-note::before { bottom: 100%; }
.aiui-rtx-notes-above .aiui-rtx-note::before { top: 100%; }
.aiui-rtx-error { color: #cc0000; font-family: ui-monospace, monospace; white-space: pre-wrap; }
`;

const STYLE_MARK = "data-aiui-rich-tex";
function ensureStyles(): void {
  if (typeof document === "undefined") return;
  let el = document.head.querySelector<HTMLStyleElement>(`style[${STYLE_MARK}]`);
  if (el === null) {
    el = document.createElement("style");
    el.setAttribute(STYLE_MARK, "");
    document.head.append(el);
  }
  // Refresh, don't just create: a hot edit of the structural CSS must land
  // on the open page too, or the old rules outlive the module that wrote them.
  if (el.textContent !== RICH_TEX_STYLES) el.textContent = RICH_TEX_STYLES;
}

/** The term spans enclosing an element, innermost first. */
function termChain(el: Element | null, host: HTMLElement): HTMLElement[] {
  const chain: HTMLElement[] = [];
  let cur = el;
  while (cur && cur !== host) {
    if (cur instanceof HTMLElement && cur.hasAttribute(TERM_ATTR)) chain.push(cur);
    cur = cur.parentElement;
  }
  return chain;
}

const leafName = (name: string): string => name.slice(name.lastIndexOf("/") + 1);

export function RichTeX(props: RichTeXProps): JSX.Element {
  ensureStyles();
  const display = () => props.display === true;
  const assembled = createMemo(() => assembleTeX(props.children));
  const html = createMemo(() => {
    const a = assembled();
    return a.error === undefined ? renderMarked(a.marked, display()) : "";
  });

  let host!: HTMLElement;
  // id → span, for the CURRENT html; rebuilt whenever the html changes.
  let spans = new Map<string, HTMLElement>();
  // A term as the render effect last saw it: every prop the imperative side
  // needs, read ONCE in the effect's tracked compute. The handlers and the
  // delegated listeners read these, never `props` (a prop read in an effect
  // callback is untracked — Solid's STRICT_READ_UNTRACKED).
  interface Decorated {
    t: AssembledTerm;
    color: string | undefined;
    cls: string | undefined;
    active: boolean;
    control: ControlBox<number> | undefined;
    format: ((value: number) => string) | undefined;
    span: number | undefined;
    value: number | undefined;
    clickable: boolean;
  }
  let current: Decorated[] = [];
  const [boxes, setBoxes] = createSignal<ReadonlyMap<string, TermBox>>(new Map());
  const [shifts, setShifts] = createSignal<ReadonlyMap<string, number>>(new Map());
  const [mathHeight, setMathHeight] = createSignal(0);

  // ── geometry ──────────────────────────────────────────────────────────────
  // Read in rAF / observer callbacks — outside any owner, so the writes are
  // plain event-time writes (Solid 2.0 forbids writes from inside owned
  // scopes without `ownedWrite`).
  const observedNotes = new WeakSet<Element>();
  const measure = (): void => {
    if (!host.isConnected) return;
    const h = host.getBoundingClientRect();
    const next = new Map<string, TermBox>();
    for (const [id, span] of spans) {
      const b = span.getBoundingClientRect();
      next.set(id, { left: b.left - h.left, top: b.top - h.top, width: b.width, height: b.height });
    }
    setBoxes(next);
    setMathHeight(h.height);
    // Notes: the collision pass, per layer, from the widths they rendered at.
    const root = host.closest(".aiui-rtx");
    const pushed = new Map<string, number>();
    for (const layer of root?.querySelectorAll<HTMLElement>(".aiui-rtx-notes") ?? []) {
      const items: NoteItem[] = [];
      for (const n of layer.querySelectorAll<HTMLElement>(":scope > .aiui-rtx-note")) {
        const id = n.getAttribute("data-for");
        const b = id === null ? undefined : next.get(id);
        if (id === null || b === undefined) continue;
        if (ro !== undefined && !observedNotes.has(n)) {
          observedNotes.add(n); // a note that grows (a number gaining a digit) re-measures
          ro.observe(n);
        }
        items.push({ id, anchor: b.left + b.width / 2, width: n.offsetWidth });
      }
      for (const [id, dx] of resolveNoteShifts(items, NOTE_GAP)) pushed.set(id, dx);
    }
    setShifts(pushed);
    placeReadout(); // the glyphs may have moved under an open readout
  };
  let raf: number | undefined;
  const scheduleMeasure = (): void => {
    if (typeof requestAnimationFrame !== "function") return;
    if (raf !== undefined) cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      raf = undefined;
      measure();
    });
  };

  // Re-measure when the host's box changes (reflow, a font swap) and when
  // the web fonts finish loading (KaTeX's own arrive after first paint).
  // Observed from the effect handler below — the first place the host
  // element is guaranteed to exist (refs bind during render; handlers run
  // after it, the PlotFigure precedent).
  const ro = typeof ResizeObserver === "function" ? new ResizeObserver(scheduleMeasure) : undefined;
  let observed: HTMLElement | undefined;
  if (typeof document !== "undefined" && "fonts" in document) {
    document.fonts.ready.then(scheduleMeasure, () => {});
  }

  // ── hover, click, knobs: delegated to the host ────────────────────────────
  // Spans are replaced on every re-render, listeners on the host are not.
  // Nested terms: the chain from innermost outward. Attached imperatively
  // where the host is adopted (the effect below), with the resize observer —
  // the host is static markup; the terms inside it are the interactive
  // things. Knobs are focusable (tabindex) and answer the arrow keys; a
  // clickable term is focusable too and answers Enter and Space.
  let hovered = new Set<string>();
  const syncHover = (chain: HTMLElement[]): void => {
    const now = new Set(chain.map((el) => el.getAttribute(TERM_ATTR) ?? ""));
    for (const id of hovered)
      if (!now.has(id)) current.find((d) => d.t.id === id)?.t.props.onHover?.(false);
    for (const id of now)
      if (!hovered.has(id)) current.find((d) => d.t.id === id)?.t.props.onHover?.(true);
    hovered = now;
  };
  const knobOf = (id: string | null | undefined): Decorated | undefined =>
    id == null ? undefined : current.find((d) => d.t.id === id && d.control !== undefined);
  const innermostKnob = (chain: HTMLElement[]): string | undefined => {
    for (const el of chain) {
      const id = el.getAttribute(TERM_ATTR);
      if (knobOf(id) !== undefined) return id ?? undefined;
    }
    return undefined;
  };
  // The readout shows for the knob being scrubbed, else the focused one,
  // else the hovered one. Gesture state is plain (Solid 2.0 stages writes;
  // a signal read in the next synchronous pointermove would still be stale).
  interface Scrub {
    id: string;
    control: ControlBox<number>;
    startX: number;
    startV: number;
    perPx: number;
  }
  let scrub: Scrub | undefined;
  let focusedKnob: string | undefined;
  let hoveredKnob: string | undefined;
  const [hot, setHot] = createSignal<string | undefined>();
  // The readout is positioned against the VIEWPORT (position: fixed), so no
  // scroll box between it and the page — a wide equation's own overflow-x
  // scroller, a panel — can clip it; its anchor is the hot knob's glyph box
  // in viewport coordinates, refreshed on every measure and on scroll.
  const [anchor, setAnchor] = createSignal<{ x: number; y: number } | undefined>();
  const hotId = (): string | undefined => scrub?.id ?? focusedKnob ?? hoveredKnob;
  const placeReadout = (): void => {
    const id = hotId();
    const span = id === undefined ? undefined : spans.get(id);
    if (span === undefined) {
      setAnchor(undefined);
      return;
    }
    const r = span.getBoundingClientRect();
    setAnchor({ x: r.left + r.width / 2, y: r.top });
  };
  const onScroll = (): void => {
    if (hotId() !== undefined) placeReadout();
  };
  const showHot = (): void => {
    setHot(hotId());
    placeReadout();
  };

  const onPointerOver = (e: PointerEvent): void => {
    const chain = termChain(e.target as Element | null, host);
    syncHover(chain);
    hoveredKnob = innermostKnob(chain);
    showHot();
  };
  const onPointerLeave = (): void => {
    syncHover([]);
    hoveredKnob = undefined;
    showHot();
  };
  const onClick = (e: MouseEvent): void => {
    const chain = termChain(e.target as Element | null, host);
    for (const el of chain) {
      const id = el.getAttribute(TERM_ATTR);
      current.find((d) => d.t.id === id)?.t.props.onClick?.();
    }
  };
  const onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    const id = innermostKnob(termChain(e.target as Element | null, host));
    const knob = knobOf(id);
    if (id === undefined || knob?.control === undefined) return;
    const control = knob.control;
    scrub = {
      id,
      control,
      startX: e.clientX,
      startV: control.get(),
      perPx: perPxOf(control, knob.span),
    };
    // Capture so the drag survives leaving the glyphs; preventDefault so the
    // press never starts a text selection. try: a SYNTHETIC pointerdown (an
    // agent driving the page, a jsdom test) has no active pointer and
    // capture throws — the knob works without.
    try {
      host.setPointerCapture?.(e.pointerId);
    } catch {
      /* synthetic pointer — no capture */
    }
    e.preventDefault();
    spans.get(id)?.setAttribute("data-scrubbing", "true");
    showHot();
  };
  const onPointerMove = (e: PointerEvent): void => {
    if (scrub === undefined) return;
    // Accumulate from the press's raw value — the control snaps and clamps
    // each write; the drag itself stays smooth.
    scrub.control.set((scrub.startV + (e.clientX - scrub.startX) * scrub.perPx) as never);
  };
  const endScrub = (): void => {
    if (scrub === undefined) return;
    spans.get(scrub.id)?.removeAttribute("data-scrubbing");
    scrub = undefined;
    showHot();
  };
  const onKeyDown = (e: KeyboardEvent): void => {
    const span = (e.target as Element | null)?.closest?.(`[${TERM_ATTR}]`);
    const id = span?.getAttribute(TERM_ATTR);
    const d = id == null ? undefined : current.find((x) => x.t.id === id);
    if (d === undefined) return;
    if (d.control === undefined) {
      // A clickable term: Enter and Space are its click.
      if (d.clickable && (e.key === "Enter" || e.key === " ")) {
        e.preventDefault();
        d.t.props.onClick?.();
      }
      return;
    }
    const control = d.control;
    const unit = keyStepOf(control) * (e.shiftKey ? 10 : 1);
    const v = control.get();
    let next: number | undefined;
    if (e.key === "ArrowRight" || e.key === "ArrowUp") next = v + unit;
    else if (e.key === "ArrowLeft" || e.key === "ArrowDown") next = v - unit;
    else if (e.key === "Home") next = control.meta.min;
    else if (e.key === "End") next = control.meta.max;
    if (next === undefined) return;
    e.preventDefault();
    control.set(next as never);
  };
  const onFocusIn = (e: FocusEvent): void => {
    const span = (e.target as Element | null)?.closest?.(`[${TERM_ATTR}]`);
    const id = span?.getAttribute(TERM_ATTR) ?? undefined;
    if (knobOf(id) !== undefined) {
      focusedKnob = id;
      showHot();
    }
  };
  const onFocusOut = (): void => {
    focusedKnob = undefined;
    showHot();
  };

  const adopt = (el: HTMLElement): void => {
    ro?.observe(el);
    el.addEventListener("pointerover", onPointerOver);
    el.addEventListener("pointerleave", onPointerLeave);
    el.addEventListener("click", onClick);
    el.addEventListener("pointerdown", onPointerDown);
    el.addEventListener("pointermove", onPointerMove);
    el.addEventListener("pointerup", endScrub);
    el.addEventListener("pointercancel", endScrub);
    el.addEventListener("keydown", onKeyDown);
    el.addEventListener("focusin", onFocusIn);
    el.addEventListener("focusout", onFocusOut);
    el.ownerDocument.addEventListener("scroll", onScroll, { capture: true, passive: true });
  };
  const release = (el: HTMLElement): void => {
    ro?.unobserve(el);
    el.removeEventListener("pointerover", onPointerOver);
    el.removeEventListener("pointerleave", onPointerLeave);
    el.removeEventListener("click", onClick);
    el.removeEventListener("pointerdown", onPointerDown);
    el.removeEventListener("pointermove", onPointerMove);
    el.removeEventListener("pointerup", endScrub);
    el.removeEventListener("pointercancel", endScrub);
    el.removeEventListener("keydown", onKeyDown);
    el.removeEventListener("focusin", onFocusIn);
    el.removeEventListener("focusout", onFocusOut);
    el.ownerDocument.removeEventListener("scroll", onScroll, { capture: true });
  };
  onCleanup(() => {
    if (observed !== undefined) release(observed);
    ro?.disconnect();
    if (raf !== undefined) cancelAnimationFrame(raf);
  });

  // ── the render + decoration effect ────────────────────────────────────────
  // Consumer classes applied last time, per term — removed before the next
  // set goes on, so KaTeX's own classes on the span (`enclosing`, `mtight`
  // in script styles) are never touched.
  const applied = new Map<string, string[]>();
  let lastHtml: string | undefined;
  createEffect(
    () => ({
      html: html(),
      terms: assembled().terms.map(
        (t): Decorated => ({
          t,
          color: t.props.color,
          cls: t.props.class,
          active: t.props.active === true,
          control: t.props.control,
          clickable: t.props.onClick !== undefined,
          format: t.props.format,
          span: t.props.span,
          // A knob's aria state follows its control.
          value: t.props.control?.get(),
        }),
      ),
    }),
    (v) => {
      current = v.terms;
      if (observed !== host) {
        if (observed !== undefined) release(observed);
        adopt(host);
        observed = host;
        lastHtml = undefined; // a new host (display toggled) needs the markup again
      }
      if (v.html !== lastHtml) {
        lastHtml = v.html;
        host.innerHTML = v.html;
        spans = new Map();
        applied.clear();
        for (const el of host.querySelectorAll<HTMLElement>(`[${TERM_ATTR}]`)) {
          const id = el.getAttribute(TERM_ATTR);
          if (id !== null) spans.set(id, el);
        }
      }
      for (const d of v.terms) {
        const span = spans.get(d.t.id);
        if (span === undefined) continue;
        const prev = applied.get(d.t.id);
        if (prev !== undefined) span.classList.remove(...prev);
        const next = d.cls === undefined ? [] : d.cls.split(/\s+/).filter((c) => c !== "");
        span.classList.add("aiui-rtx-term", ...next);
        applied.set(d.t.id, next);
        span.style.color = d.color ?? "";
        span.setAttribute("data-tex", d.t.tex);
        if (d.active) span.setAttribute("data-active", "true");
        else span.removeAttribute("data-active");
        if (d.clickable && d.control === undefined) {
          span.setAttribute("tabindex", "0");
          span.setAttribute("role", "button");
        }
        const control = d.control;
        if (control !== undefined) {
          span.classList.add("aiui-rtx-knob");
          span.setAttribute("data-control", control.name);
          span.setAttribute("tabindex", "0");
          span.setAttribute("role", "slider");
          span.setAttribute("aria-label", control.description ?? leafName(control.name));
          if (control.meta.min !== undefined)
            span.setAttribute("aria-valuemin", String(control.meta.min));
          if (control.meta.max !== undefined)
            span.setAttribute("aria-valuemax", String(control.meta.max));
          if (d.value !== undefined) {
            span.setAttribute("aria-valuenow", String(d.value));
            span.setAttribute(
              "aria-valuetext",
              d.format ? d.format(d.value) : formatKnob(d.value, control.meta),
            );
          }
        }
      }
      scheduleMeasure();
    },
  );

  // ── the knob readout ──────────────────────────────────────────────────────
  const hotKnob = createMemo(() => {
    const id = hot();
    return id === undefined
      ? undefined
      : assembled().terms.find((t) => t.id === id && t.props.control !== undefined);
  });
  const Readout = () => (
    <Show when={hotKnob()}>
      {(k) => {
        const control = () => k().props.control as ControlBox<number>;
        const shown = () => {
          const v = control().get();
          return k().props.format
            ? (k().props.format as (v: number) => string)(v)
            : formatKnob(v, control().meta);
        };
        return (
          <span
            class="aiui-rtx-readout"
            data-for={k().id}
            data-control={control().name}
            style={{
              left: `${anchor()?.x ?? 0}px`,
              top: `${anchor()?.y ?? 0}px`,
              visibility: anchor() === undefined ? "hidden" : undefined,
            }}
          >
            <b class="aiui-rtx-readout-value">{shown()}</b>
            <span class="aiui-rtx-readout-name">{leafName(control().name)}</span>
          </span>
        );
      }}
    </Show>
  );

  // ── notes ─────────────────────────────────────────────────────────────────
  const notes = createMemo(() =>
    display() ? assembled().terms.filter((t) => "note" in t.props) : [],
  );
  const notesOn = (side: "below" | "above") =>
    notes().filter((t) => (t.props.place ?? "below") === side);
  // New or departed notes change the collision picture: measure again.
  createEffect(
    () => notes().length,
    () => scheduleMeasure(),
  );

  const Layer = (p: { side: "below" | "above" }) => (
    <Show when={notesOn(p.side).length > 0}>
      <div class={`aiui-rtx-notes aiui-rtx-notes-${p.side}`}>
        <For each={notesOn(p.side)}>
          {(t) => {
            const box = () => boxes().get(t.id);
            const x = () => {
              const b = box();
              return b === undefined ? 0 : b.left + b.width / 2;
            };
            // From the equation's edge to the glyphs' near edge; the
            // stylesheet adds the layer gap (`--aiui-rtx-gap`) and a standoff.
            const leader = () => {
              const b = box();
              if (b === undefined) return 0;
              const toGlyphs = p.side === "below" ? mathHeight() - (b.top + b.height) : b.top;
              return Math.max(0, toGlyphs);
            };
            return (
              <div
                class="aiui-rtx-note"
                data-for={t.id}
                data-active={t.props.active === true ? "true" : undefined}
                style={{
                  "--aiui-rtx-x": String(x()),
                  "--aiui-rtx-w": String(box()?.width ?? 0),
                  "--aiui-rtx-shift": String(shifts().get(t.id) ?? 0),
                  "--aiui-rtx-leader-len": String(leader()),
                  visibility: box() === undefined ? "hidden" : undefined,
                }}
              >
                {t.props.note}
              </div>
            );
          }}
        </For>
      </div>
    </Show>
  );

  const rootClass = () => {
    const base = display() ? "math-display aiui-rtx" : "math-inline aiui-rtx aiui-rtx-inline";
    return props.class === undefined ? base : `${base} ${props.class}`;
  };
  const err = () => assembled().error;

  return (
    <Show
      when={display()}
      fallback={
        <span class={rootClass()} data-tex={assembled().clean}>
          <Show when={err()}>{(e) => <span class="aiui-rtx-error">{e()}</span>}</Show>
          <span class="aiui-rtx-stage">
            <span
              class="aiui-rtx-math"
              ref={(el) => {
                host = el;
              }}
            />
            <Readout />
          </span>
        </span>
      }
    >
      <div class={rootClass()} data-tex={assembled().clean}>
        <Show when={err()}>{(e) => <div class="aiui-rtx-error">{e()}</div>}</Show>
        <Layer side="above" />
        <div class="aiui-rtx-stage">
          <div
            class="aiui-rtx-math"
            ref={(el) => {
              host = el;
            }}
          />
          <Readout />
        </div>
        <Layer side="below" />
      </div>
    </Show>
  );
}
