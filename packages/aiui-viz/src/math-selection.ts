/**
 * math-selection.ts — the mathematics inside a DOM Range, as TeX. Framework-
 * free (no Solid, no KaTeX import): it reads the DOM contract the renderers
 * leave behind.
 *
 * Two consumers, one resolver, so a human's clipboard and an agent's
 * `selection` call agree on what a selection inside an equation means:
 *
 *  - {@link mathOfRange} answers for the `selection` tool: when the range
 *    touches rendered math, the TeX it covers at the finest precision the
 *    stamps allow. Any KaTeX equation resolves as a whole — by the `data-tex`
 *    stamp aiui-viz's `TeX` and `RichTeX` leave on their wrapper, else by
 *    KaTeX's own MathML annotation. Inside a `RichTeX` equation, whose terms
 *    carry `data-aiui-term` and their own `data-tex`, the ladder goes finer:
 *    the smallest term that contains the whole range; else the outermost
 *    terms the range touches, in source order, provided every selected glyph
 *    lies in one of them; a selection that also takes glyphs between terms
 *    falls back to the equation. (The precision ladder the prompts inspector
 *    names: block · whole equation · range.)
 *  - {@link clipboardFor} answers for the `copy` event: the selection as
 *    plain text with every equation replaced by its TeX in `$…$` / `$$…$$`,
 *    the prose around it intact, a partially selected equation at either end
 *    resolved through the same ladder — plus an HTML flavor that carries
 *    MathML for whole equations, so a paste into a rich editor is still
 *    mathematics. Without this, KaTeX's HTML layer copies as glyph fragments
 *    on separate lines (subscripts and accents each on their own). The method
 *    is KaTeX's own `copy-tex` extension's — clone the range, substitute —
 *    with two differences: the clean stamp wins over the annotation (a
 *    `RichTeX` annotation holds the marker syntax), and a partial selection
 *    resolves to terms instead of swallowing the whole equation.
 *
 * {@link installMathCopy} wires the handler once per document.
 * `ensureAiuiGlobal` calls it beside the selection watcher: that one READS
 * `selectionchange` and remembers; this one WRITES the clipboard on `copy`.
 * Nothing is shared between them and the document's selection is never
 * modified — the user's highlight stays exactly where they put it.
 */

/** The attribute a `RichTeX` term's span carries (its value is the term id). */
export const MATH_TERM_ATTR = "data-aiui-term";

export interface MathInRange {
  /** The TeX the range covers: a whole equation, one term, or several terms joined by spaces. */
  tex: string;
  /** Display math (`$$…$$` when fenced). Always false for a term selection. */
  display: boolean;
  /** How fine the answer is: the whole equation, the smallest term containing
   * the range, or the outermost terms it covers. */
  precision: "equation" | "term" | "terms";
  /** The covered terms' ids (`data-aiui-term`), in source order; empty for an equation. */
  terms: string[];
}

export interface MathClipboard {
  /** `text/plain`: the selection with every equation as TeX. */
  text: string;
  /** `text/html`: the selection with whole equations as MathML; absent when
   * the selection is one partial equation (the TeX text stands alone). */
  html?: string;
}

const elementOf = (node: Node | null): Element | null =>
  node === null
    ? null
    : node.nodeType === Node.ELEMENT_NODE
      ? (node as Element)
      : node.parentElement;

const katexRootOf = (node: Node | null): Element | null =>
  elementOf(node)?.closest(".katex") ?? null;

const lengthOf = (node: Node): number =>
  node.nodeType === Node.TEXT_NODE ? (node as Text).data.length : node.childNodes.length;

/**
 * Where a node sits against the range: `-1` entirely before it, `1` entirely
 * after, `0` overlapping (or touching). `comparePoint` on the node's own
 * start and end, so a boundary that merely touches the node counts as zero
 * overlap by the length test below, never as a glyph.
 */
function coveredLength(range: Range, node: Node): number {
  const doc = node.ownerDocument;
  if (doc === null) return 0;
  const len = lengthOf(node);
  const startSide = range.comparePoint(node, 0);
  const endSide = range.comparePoint(node, len);
  if (startSide === 1 || endSide === -1) return 0; // node wholly after / before the range
  const r = doc.createRange();
  r.selectNodeContents(node);
  if (startSide === -1) r.setStart(range.startContainer, range.startOffset); // node starts before the range
  if (endSide === 1) r.setEnd(range.endContainer, range.endOffset); // node ends after it
  return r.collapsed ? 0 : r.toString().length;
}

/** Is the whole range inside the node? (`comparePoint` cannot tell "at the
 * boundary" from "inside", so this compares boundary points directly.) */
function rangeWithin(range: Range, node: Node): boolean {
  const doc = node.ownerDocument;
  if (doc === null) return false;
  const r = doc.createRange();
  r.selectNodeContents(node);
  return (
    range.compareBoundaryPoints(Range.START_TO_START, r) >= 0 &&
    range.compareBoundaryPoints(Range.END_TO_END, r) <= 0
  );
}

/** The glyph text nodes of a KaTeX root the range covers (its HTML layer only — the MathML is hidden). */
function selectedGlyphs(k: Element, range: Range): Text[] {
  const html = k.querySelector(".katex-html") ?? k;
  const doc = k.ownerDocument;
  const out: Text[] = [];
  const walker = doc.createTreeWalker(html, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
    const t = n as Text;
    if (t.data.trim() !== "" && coveredLength(range, t) > 0) out.push(t);
  }
  return out;
}

interface Equation {
  tex: string | undefined;
  display: boolean;
  /** KaTeX's MathML half, for the rich flavor. */
  mathml: Element | null;
}

/** The equation a KaTeX root renders: the stamp on its wrapper (clean), else its annotation. */
function equationOf(k: Element): Equation {
  // The term spans with their own `data-tex` live INSIDE the root; the
  // equation's stamp is the nearest one ABOVE it.
  const stamped = k.parentElement?.closest("[data-tex]") ?? null;
  const annotation =
    k.querySelector('annotation[encoding="application/x-tex"]')?.textContent ?? undefined;
  return {
    tex: stamped?.getAttribute("data-tex") ?? annotation,
    display:
      k.closest(".katex-display") !== null ||
      (stamped?.classList.contains("math-display") ?? false),
    mathml: k.querySelector(".katex-mathml math"),
  };
}

/** The TeX the range covers inside ONE KaTeX root, by the term ladder. */
function partOf(k: Element, range: Range): MathInRange | undefined {
  const eq = equationOf(k);
  const whole = (): MathInRange | undefined =>
    eq.tex === undefined
      ? undefined
      : { tex: eq.tex, display: eq.display, precision: "equation", terms: [] };
  // Document order: a term precedes the terms nested inside it.
  const spans = Array.from(k.querySelectorAll<HTMLElement>(`[${MATH_TERM_ATTR}][data-tex]`));
  if (spans.length === 0) return whole();
  const hits = spans.filter((s) => coveredLength(range, s) > 0);
  if (hits.length === 0) return whole();
  const innermost = hits.filter((s) => rangeWithin(range, s)).at(-1);
  if (innermost !== undefined) {
    return {
      tex: innermost.getAttribute("data-tex") ?? "",
      display: false,
      precision: "term",
      terms: [innermost.getAttribute(MATH_TERM_ATTR) ?? ""],
    };
  }
  const outermost = hits.filter((s) => !hits.some((o) => o !== s && o.contains(s)));
  const covered = selectedGlyphs(k, range).every((t) => outermost.some((s) => s.contains(t)));
  if (!covered) return whole();
  return {
    tex: outermost.map((s) => s.getAttribute("data-tex") ?? "").join(" "),
    display: false,
    precision: "terms",
    terms: outermost.map((s) => s.getAttribute(MATH_TERM_ATTR) ?? ""),
  };
}

/** Every KaTeX root the range touches, in document order. */
function katexRootsIn(range: Range): Element[] {
  const ca = elementOf(range.commonAncestorContainer);
  if (ca === null) return [];
  const inner = ca.closest(".katex");
  if (inner !== null) return [inner];
  return Array.from(ca.querySelectorAll(".katex")).filter((k) => range.intersectsNode(k));
}

/**
 * The mathematics the range covers, or undefined when it touches none. A
 * range spanning prose and several equations answers for the first one it
 * touches (the `selection` tool's `tex` is "the math at the start"; its
 * `markdown` format carries the whole fragment).
 */
export function mathOfRange(range: Range): MathInRange | undefined {
  if (range.collapsed) return undefined;
  const start = katexRootOf(range.startContainer);
  const k = start ?? katexRootsIn(range)[0];
  if (k !== undefined && k !== null) return partOf(k, range);
  // A `data-tex` stamp with no KaTeX under it (a host rendering math some
  // other way): the stamp alone, as `texOfElement` has always answered.
  const stamped = elementOf(range.startContainer)?.closest("[data-tex]") ?? null;
  if (stamped === null) return undefined;
  return {
    tex: stamped.getAttribute("data-tex") ?? "",
    display: stamped.classList.contains("math-display"),
    precision: "equation",
    terms: [],
  };
}

function fence(tex: string, display: boolean): string {
  const t = tex.trim();
  return display ? `$$${t}$$` : `$${t}$`;
}

/** KaTeX's MathML for a whole equation, its annotation set to the clean TeX. */
function mathmlFor(eq: Equation, tex: string): Element | undefined {
  if (eq.mathml === null) return undefined;
  const math = eq.mathml.cloneNode(true) as Element;
  const annotation = math.querySelector("annotation");
  if (annotation !== null) annotation.textContent = tex;
  if (eq.display) math.setAttribute("display", "block");
  return math;
}

/**
 * What the clipboard should carry for a selection that touches rendered
 * math, or undefined when it touches none (the browser's own copy stands).
 */
export function clipboardFor(range: Range): MathClipboard | undefined {
  if (range.collapsed) return undefined;
  const roots = katexRootsIn(range);
  if (roots.length === 0) return undefined;
  const doc = roots[0]?.ownerDocument;
  if (doc === undefined) return undefined;

  // One equation, selected from inside: no prose around it to keep.
  const ca = elementOf(range.commonAncestorContainer);
  if (roots.length === 1 && ca !== null && ca.closest(".katex") !== null) {
    const k = roots[0] as Element;
    const m = partOf(k, range);
    if (m === undefined) return undefined;
    if (m.precision !== "equation") return { text: fence(m.tex, false) };
    const math = mathmlFor(equationOf(k), m.tex);
    return { text: fence(m.tex, m.display), ...(math ? { html: math.outerHTML } : {}) };
  }

  // Prose with equations in it: substitute each equation in a clone of the
  // selection. `cloneContents` includes exactly the nodes `intersectsNode`
  // admits, in the same order, so the i-th cloned root is the i-th live one.
  const parts = roots.map((k) => {
    if (coveredLength(range, k) === 0) return { text: "", node: undefined };
    const m = partOf(k, range);
    if (m === undefined) return { text: k.textContent ?? "", node: undefined };
    if (m.precision !== "equation") return { text: fence(m.tex, false), node: undefined };
    const text = fence(m.tex, m.display);
    return { text, node: mathmlFor(equationOf(k), m.tex) };
  });
  const substitute = (frag: DocumentFragment, rich: boolean): DocumentFragment | undefined => {
    const clones = Array.from(frag.querySelectorAll(".katex"));
    if (clones.length !== roots.length) return undefined;
    clones.forEach((c, i) => {
      const part = parts[i] as (typeof parts)[number];
      const node = rich && part.node !== undefined ? part.node.cloneNode(true) : undefined;
      c.replaceWith(node ?? doc.createTextNode(part.text));
    });
    return frag;
  };
  const plain = substitute(range.cloneContents(), false);
  if (plain === undefined) {
    // The clone and the live walk disagree (a host that re-parents mid-copy):
    // keep the math, drop the prose, never hand back glyph soup.
    return {
      text: parts
        .map((p) => p.text)
        .filter((t) => t !== "")
        .join("\n"),
    };
  }
  const rich = substitute(range.cloneContents(), true);
  const holder = doc.createElement("div");
  if (rich !== undefined) holder.append(rich);
  return {
    text: (plain.textContent ?? "").replace(/[ \t]+\n/g, "\n"),
    ...(rich !== undefined ? { html: holder.innerHTML } : {}),
  };
}

const installed = new WeakSet<Document>();

/**
 * Make `copy` inside rendered mathematics put TeX on the clipboard (see the
 * module doc). Idempotent per document; a no-op without a DOM. A selection
 * inside a text field or an editable region is left to the browser. Returns
 * the uninstall function.
 */
export function installMathCopy(doc: Document | undefined = globalDocument()): () => void {
  if (doc === undefined || installed.has(doc) || typeof doc.addEventListener !== "function") {
    return () => {};
  }
  const onCopy = (e: ClipboardEvent): void => {
    const sel = doc.getSelection();
    if (sel === null || sel.isCollapsed || sel.rangeCount === 0 || e.clipboardData === null) return;
    const range = sel.getRangeAt(0);
    const el = elementOf(range.commonAncestorContainer);
    if (el !== null && el.closest("input, textarea, [contenteditable]") !== null) return;
    const out = clipboardFor(range);
    if (out === undefined) return;
    e.clipboardData.setData("text/plain", out.text);
    if (out.html !== undefined) e.clipboardData.setData("text/html", out.html);
    e.preventDefault();
  };
  doc.addEventListener("copy", onCopy);
  installed.add(doc);
  return () => {
    doc.removeEventListener("copy", onCopy);
    installed.delete(doc);
  };
}

function globalDocument(): Document | undefined {
  return typeof document === "undefined" ? undefined : document;
}
