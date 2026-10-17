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
 * **Knobs and notes are the shared primitives.** A term with `control` is a
 * knob — the gesture, the readout, the `data-control` stamp and the ARIA are
 * `knob.tsx`'s (`createKnobs`, `KnobReadout`); this component only says which
 * spans are knobs after each render. A term's `note` goes to `notes.tsx`'s
 * `NoteLayer` in its `margin` layout: one strip above the equation, one
 * below, each a one-cell grid sized to its tallest note, with the collision
 * pass and the leaders. Notes render for display math only — an inline
 * equation has no room for a strip. One control may back several knobs (ε
 * appears twice in a clip); give those explicit ids.
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
import { createEffect, createMemo, onCleanup, Show } from "solid-js";
import type { ControlBox } from "../control";
import { MATH_TERM_ATTR } from "../math-selection";
import { createKnobs, KnobReadout } from "./knob";
import { NoteLayer, type NoteSpec } from "./notes";
import { ensureStyles } from "./styles";
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
  /** Annotation JSX, rendered in the notes strip anchored to this term. */
  note?: JSX.Element;
  /** Which side of the equation the note sits on. Default `below`. */
  place?: "below" | "above";
  /** Pointer enters/leaves the term's glyphs (nested terms notify every
   * enclosing term too). */
  onHover?: (hovering: boolean) => void;
  /** A click on the term's glyphs. */
  onClick?: () => void;
  /** Makes the term a KNOB: the symbol of this numeric control. Hover for the
   * value, drag to change it, arrow keys when focused (see knob.tsx). */
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

// ── structural CSS (positions only; the look is the consumer's) ─────────────

export const RICH_TEX_STYLES = `
.aiui-rtx { position: relative; }
.aiui-rtx-stage { position: relative; }
.aiui-rtx-math { display: block; }
.aiui-rtx-inline > .aiui-rtx-stage, .aiui-rtx-inline .aiui-rtx-math { display: inline; }
.aiui-rtx .katex-display { margin: 0; }
.aiui-rtx-error { color: #cc0000; font-family: ui-monospace, monospace; white-space: pre-wrap; }
`;
const STYLE_MARK = "data-aiui-rich-tex";

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

export function RichTeX(props: RichTeXProps): JSX.Element {
  ensureStyles(STYLE_MARK, RICH_TEX_STYLES);
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
    clickable: boolean;
  }
  let current: Decorated[] = [];
  // The knobs: the gesture, the readout and the stamps live in knob.tsx; this
  // component binds the knob spans after each render. A press resolves to
  // the innermost knob span enclosing it (the default), which is what nested
  // terms need.
  const knobs = createKnobs();

  // ── hover and click: delegated to the host ────────────────────────────────
  // Spans are replaced on every re-render, listeners on the host are not.
  // Nested terms: the chain from innermost outward. Attached imperatively
  // where the host is adopted (the effect below), because refs bind during
  // render and effect handlers run after it. A clickable term is focusable
  // and answers Enter and Space; a knob's keys are the knob controller's.
  let hovered = new Set<string>();
  const syncHover = (chain: HTMLElement[]): void => {
    const now = new Set(chain.map((el) => el.getAttribute(TERM_ATTR) ?? ""));
    for (const id of hovered)
      if (!now.has(id)) current.find((d) => d.t.id === id)?.t.props.onHover?.(false);
    for (const id of now)
      if (!hovered.has(id)) current.find((d) => d.t.id === id)?.t.props.onHover?.(true);
    hovered = now;
  };
  const onPointerOver = (e: PointerEvent): void =>
    syncHover(termChain(e.target as Element | null, host));
  const onPointerLeave = (): void => syncHover([]);
  const onClick = (e: MouseEvent): void => {
    const chain = termChain(e.target as Element | null, host);
    for (const el of chain) {
      const id = el.getAttribute(TERM_ATTR);
      current.find((d) => d.t.id === id)?.t.props.onClick?.();
    }
  };
  const onKeyDown = (e: KeyboardEvent): void => {
    const span = (e.target as Element | null)?.closest?.(`[${TERM_ATTR}]`);
    const id = span?.getAttribute(TERM_ATTR);
    const d = id == null ? undefined : current.find((x) => x.t.id === id);
    if (d === undefined || d.control !== undefined || !d.clickable) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      d.t.props.onClick?.();
    }
  };

  let observed: HTMLElement | undefined;
  const adopt = (el: HTMLElement): void => {
    el.addEventListener("pointerover", onPointerOver);
    el.addEventListener("pointerleave", onPointerLeave);
    el.addEventListener("click", onClick);
    el.addEventListener("keydown", onKeyDown);
    knobs.attach(el);
  };
  const release = (el: HTMLElement): void => {
    el.removeEventListener("pointerover", onPointerOver);
    el.removeEventListener("pointerleave", onPointerLeave);
    el.removeEventListener("click", onClick);
    el.removeEventListener("keydown", onKeyDown);
  };
  onCleanup(() => {
    if (observed !== undefined) release(observed);
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
        knobs.clear();
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
        if (d.control !== undefined) {
          knobs.bind(span, { control: d.control, span: d.span, format: d.format });
        } else {
          knobs.unbind(span);
          if (d.clickable) {
            span.setAttribute("tabindex", "0");
            span.setAttribute("role", "button");
          } else {
            span.removeAttribute("tabindex");
            span.removeAttribute("role");
          }
        }
      }
    },
  );

  // ── notes ─────────────────────────────────────────────────────────────────
  // One spec per annotated term, keyed on the assembled term (a re-assembly
  // rebuilds them, as it rebuilds the spans). Display math only.
  const notes = createMemo((): NoteSpec[] =>
    display()
      ? assembled()
          .terms.filter((t) => "note" in t.props)
          .map((t) => ({
            id: t.id,
            get side() {
              return t.props.place ?? "below";
            },
            get active() {
              return t.props.active === true;
            },
            get note() {
              return t.props.note;
            },
          }))
      : [],
  );
  const Layer = (p: { side: "above" | "below" }) => (
    <NoteLayer
      layout="margin"
      side={p.side}
      host={() => host}
      anchorOf={(id) => spans.get(id)}
      notes={notes()}
      version={html()}
    />
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
            <KnobReadout of={knobs} />
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
          <KnobReadout of={knobs} />
        </div>
        <Layer side="below" />
      </div>
    </Show>
  );
}
