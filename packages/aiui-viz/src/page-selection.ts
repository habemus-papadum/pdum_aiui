/**
 * page-selection.ts — what the user has selected on the page, as a model can
 * use it. Framework-free (no Solid): the engine of the `selection` standard
 * tool and of the page's own `window.__AIUI__.selection(options)`.
 *
 * One selection, three things a model wants from it:
 *
 *  - the TEXT — capped, a prompt block rather than a document — and, when the
 *    selection starts inside rendered mathematics, the TeX behind it (the
 *    `data-tex` stamp aiui-viz's `TeX` component leaves, else KaTeX's own
 *    MathML annotation). `format: "markdown"` also renders the selected
 *    fragment through page-text, so a table stays a table and every equation
 *    in it is TeX;
 *  - the ATTRIBUTION the DOM contract carries (docs/attribution.md), read off
 *    the selection's START element: the element chain — its stamped
 *    ancestors, nearest first, "which JSX authored this" — and the cell chain
 *    — the containing `data-cell` ancestors, each at its DEFINITION site and
 *    with its live state, "which computation produced this" — plus the
 *    control the selection sits in. Every location comes split (`file`,
 *    `line`, `col`) beside the raw stamp, and `file` is exactly the path the
 *    `source` tool takes;
 *  - the GEOMETRY (`rects: true`): the selection's client rects in viewport
 *    coordinates, for a consumer that annotates a screenshot.
 *
 * Snapshot, not read-through. The moment focus moves into a textarea — the
 * voice dock's key field, a host's prompt box — the document selection reads
 * empty, and that is exactly the moment a user who just selected something
 * presses a button. So the module remembers the LAST non-collapsed selection
 * (a cloned Range, refreshed on a debounced `selectionchange` and on every
 * read) for {@link SELECTION_TTL_MS}, and a read answered from that memory
 * says `live: false`. A selection inside agent chrome (the dock, the tool
 * log — `data-aiui-chrome`) is never one.
 *
 * A host can read the same contract on its own — an extension's content
 * script runs in an isolated world that cannot see this global, so it walks
 * the same stamps itself (the former intent tool's selection watcher did);
 * a host driving the page over CDP calls this when the page has it.
 */
import { AGENT_CHROME_ATTR, pageText, texOfElement } from "./page-text";

/** Characters of text a read returns when `maxChars` is not given. */
export const SELECTION_DEFAULT_CHARS = 1000;
/** The hard cap on `maxChars`. */
export const SELECTION_MAX_CHARS = 16_384;
/** Element and cell chain length when `depth` is not given. */
export const SELECTION_DEFAULT_DEPTH = 4;
/** The hard cap on `depth`. */
export const SELECTION_MAX_DEPTH = 12;
/** How long a remembered selection answers after the document's own went away. */
export const SELECTION_TTL_MS = 120_000;
/** At most this many client rects ride a result. */
const MAX_RECTS = 20;
const DEBOUNCE_MS = 150;

/** A stamp (`file:line[:col]`) split for a caller that joins nothing. */
export interface SourceLoc {
  /** The stamp as the DOM carries it. */
  loc: string;
  /** The file part — exactly what the `source` tool accepts. */
  file: string;
  line?: number;
  col?: number;
}

/** One stamped ancestor of the selection's start element. */
export interface SelectedElement extends Partial<SourceLoc> {
  tag: string;
}

/** One containing cell of the selection's start element. */
export interface SelectedCell extends Partial<SourceLoc> {
  name: string;
  /** The cell's live state, when the page runs aiui-viz's cell registry. */
  state?: string;
}

/** A highlight rectangle in viewport coordinates (from `getClientRects`). */
export interface SelectionRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PageSelectionOptions {
  /** Characters of text (default {@link SELECTION_DEFAULT_CHARS}, at most
   * {@link SELECTION_MAX_CHARS}). */
  maxChars?: number;
  /** How far the element and cell chains reach, nearest first (default
   * {@link SELECTION_DEFAULT_DEPTH}, at most {@link SELECTION_MAX_DEPTH}). */
  depth?: number;
  /** Include the source locations (default true). `false` keeps the chains'
   * tags, names and states and drops every `file`/`line`/`col`/`loc`. */
  source?: boolean;
  /** Include the client rects (default false). */
  rects?: boolean;
  /** `"markdown"` adds the selected fragment rendered through page-text. */
  format?: "text" | "markdown";
}

export interface PageSelection {
  /** The selected text, trimmed, at most `maxChars` characters. */
  text: string;
  /** The whole selection's length, so a caller knows what `text` left out. */
  chars: number;
  /** True when `text` stops before the selection does. */
  truncated: boolean;
  /** TeX source when the selection starts inside rendered mathematics. */
  tex?: string;
  /** The selected fragment as page-text renders it (`format: "markdown"`). */
  markdown?: string;
  /** The stamped ancestors of the start element, nearest first. */
  elements: SelectedElement[];
  /** The containing cells of the start element, nearest first. */
  cells: SelectedCell[];
  /** The control (`data-control`) the selection sits in, if any. */
  control?: string;
  rects?: SelectionRect[];
  /** `location.href` when the selection was made. */
  url: string;
  /** Epoch ms when the selection was made. */
  at: number;
  /** True when this is the document's selection right now; false when it is
   * the remembered one (the document's has collapsed since — focus moved). */
  live: boolean;
}

/** Split a stamp into its file and position. A stamp with no position keeps the whole string as the file. */
export function splitLoc(loc: string): SourceLoc {
  const m = /^(.+?):(\d+)(?::(\d+))?$/.exec(loc);
  if (m === null) return { loc, file: loc };
  return {
    loc,
    file: m[1] ?? loc,
    line: Number(m[2]),
    ...(m[3] !== undefined ? { col: Number(m[3]) } : {}),
  };
}

interface CellsBridge {
  loc?: (name: string) => string | undefined;
  state?: (name: string) => string | undefined;
}

/** aiui-viz's cell registry, as it mirrors itself for the DOM contract's consumers (cell.ts). */
function cellsBridge(): CellsBridge | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return (window as unknown as { __aiuiCells?: CellsBridge }).__aiuiCells;
  } catch {
    return undefined;
  }
}

/** The element to attribute a range from: its start element (text → parent). */
function startElementOf(range: Range): Element | null {
  const node = range.startContainer;
  return node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
}

function elementOf(node: Node): Element | null {
  return node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
}

/** Is the range inside agent chrome (the dock, the tool log)? Never a selection. */
function inAgentChrome(range: Range): boolean {
  const el = elementOf(range.commonAncestorContainer);
  return el !== null && el.closest(`[${AGENT_CHROME_ATTR}]`) !== null;
}

/**
 * The stamped-ancestor chain, nearest → outermost (the same walk a host's
 * jump picker does). Consecutive duplicate stamps collapse.
 */
function elementChain(start: Element, depth: number, withSource: boolean): SelectedElement[] {
  const out: SelectedElement[] = [];
  let lastLoc: string | undefined;
  let el: Element | null = start.closest("[data-source-loc]");
  while (el !== null && out.length < depth) {
    const loc = el.getAttribute("data-source-loc");
    if (loc !== null && loc !== "" && loc !== lastLoc) {
      lastLoc = loc;
      out.push({ tag: el.tagName.toLowerCase(), ...(withSource ? splitLoc(loc) : {}) });
    }
    el = el.parentElement?.closest("[data-source-loc]") ?? null;
  }
  return out;
}

/**
 * A cell element's definition site — THE shared resolution ladder (a host
 * that cannot see the page's globals, like an extension, re-implements the
 * same ladder over the stamps): `data-cell-loc`, the live registry, the
 * element's own JSX stamp, then the first stamped descendant.
 */
function cellLocOf(el: Element, name: string, bridge: CellsBridge | undefined): string | undefined {
  let viaBridge: string | undefined;
  try {
    viaBridge = bridge?.loc?.(name);
  } catch {
    viaBridge = undefined; // a broken bridge must never break attribution
  }
  return (
    el.getAttribute("data-cell-loc") ??
    viaBridge ??
    el.getAttribute("data-source-loc") ??
    el.querySelector("[data-source-loc]")?.getAttribute("data-source-loc") ??
    undefined
  );
}

/** The containing-cell chain, nearest → outermost, each with its state and definition site. */
function cellChain(start: Element, depth: number, withSource: boolean): SelectedCell[] {
  const bridge = cellsBridge();
  const out: SelectedCell[] = [];
  for (let el: Element | null = start; el !== null && out.length < depth; el = el.parentElement) {
    const name = el.getAttribute("data-cell");
    if (name === null || name === "") continue;
    let state: string | undefined;
    try {
      state = bridge?.state?.(name);
    } catch {
      state = undefined;
    }
    const loc = withSource ? cellLocOf(el, name, bridge) : undefined;
    out.push({
      name,
      ...(state !== undefined ? { state } : {}),
      ...(loc !== undefined ? splitLoc(loc) : {}),
    });
  }
  return out;
}

/** Up to {@link MAX_RECTS} client rects; `[]` where `Range.getClientRects` is absent (jsdom). */
function rectsOf(range: Range): SelectionRect[] {
  const out: SelectionRect[] = [];
  if (typeof range.getClientRects !== "function") return out;
  const list = range.getClientRects();
  for (let i = 0; i < list.length && out.length < MAX_RECTS; i++) {
    const r = list[i];
    if (r !== undefined) out.push({ x: r.x, y: r.y, w: r.width, h: r.height });
  }
  return out;
}

/** The selected fragment, rendered as page-text renders a page. */
function markdownOf(range: Range, maxChars: number): string {
  const host = document.createElement("div");
  host.append(range.cloneContents());
  return pageText({ root: host, maxChars }).text;
}

const clampInt = (n: unknown, fallback: number, lo: number, hi: number): number =>
  typeof n === "number" && Number.isFinite(n)
    ? Math.min(hi, Math.max(lo, Math.floor(n)))
    : fallback;

/** Describe a non-collapsed range (see the module doc for the shape). */
export function describeRange(
  range: Range,
  options: PageSelectionOptions = {},
  stamp: { at: number; live: boolean } = { at: Date.now(), live: true },
): PageSelection {
  const maxChars = clampInt(options.maxChars, SELECTION_DEFAULT_CHARS, 1, SELECTION_MAX_CHARS);
  const depth = clampInt(options.depth, SELECTION_DEFAULT_DEPTH, 0, SELECTION_MAX_DEPTH);
  const withSource = options.source !== false;
  const whole = range.toString().trim();
  const start = startElementOf(range);
  const tex = texOfElement(start);
  const control = start?.closest("[data-control]")?.getAttribute("data-control") ?? undefined;
  return {
    text: whole.slice(0, maxChars),
    chars: whole.length,
    truncated: whole.length > maxChars,
    ...(tex !== undefined ? { tex } : {}),
    ...(options.format === "markdown" ? { markdown: markdownOf(range, maxChars) } : {}),
    elements: start === null ? [] : elementChain(start, depth, withSource),
    cells: start === null ? [] : cellChain(start, depth, withSource),
    ...(control !== undefined && control !== "" ? { control } : {}),
    ...(options.rects === true ? { rects: rectsOf(range) } : {}),
    url: typeof location !== "undefined" ? location.href : "",
    at: stamp.at,
    live: stamp.live,
  };
}

// ── the memory ──────────────────────────────────────────────────────────────

let remembered: { range: Range; at: number } | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let watching = false;

/** The document's selection right now, when it is a real one (non-collapsed, non-empty, not chrome). */
function liveRange(): Range | undefined {
  const sel = typeof window !== "undefined" ? window.getSelection?.() : null;
  if (sel == null || sel.rangeCount === 0 || sel.isCollapsed) return undefined;
  const range = sel.getRangeAt(0);
  if (range.toString().trim() === "" || inAgentChrome(range)) return undefined;
  return range;
}

function remember(range: Range, at: number): void {
  remembered = { range: range.cloneRange(), at };
}

/** The remembered selection, while it is still worth answering with. */
function rememberedRange(): { range: Range; at: number } | undefined {
  if (remembered === undefined) return undefined;
  const { range, at } = remembered;
  if (Date.now() - at > SELECTION_TTL_MS || range.collapsed || range.toString().trim() === "") {
    remembered = undefined; // expired, or the DOM it spanned is gone
    return undefined;
  }
  return remembered;
}

/**
 * Start remembering selections (a debounced `selectionchange` listener).
 * Idempotent; a no-op without a DOM. `ensureAiuiGlobal` calls it, so a page
 * that runs aiui-viz remembers from the start. Returns the stop function.
 */
export function watchPageSelection(): () => void {
  if (
    watching ||
    typeof document === "undefined" ||
    typeof document.addEventListener !== "function"
  ) {
    return () => {};
  }
  const onChange = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      const range = liveRange();
      if (range !== undefined) remember(range, Date.now());
    }, DEBOUNCE_MS);
  };
  document.addEventListener("selectionchange", onChange);
  watching = true;
  return () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    document.removeEventListener("selectionchange", onChange);
    watching = false;
  };
}

/** Forget the remembered selection (a consumer that consumed it, a test). */
export function clearPageSelection(): void {
  remembered = undefined;
}

/**
 * What the user has selected: the document's selection when there is one,
 * else the remembered one (`live: false`) while it lasts, else null.
 */
export function pageSelection(options: PageSelectionOptions = {}): PageSelection | null {
  if (typeof document === "undefined") return null;
  const live = liveRange();
  if (live !== undefined) {
    const at = Date.now();
    remember(live, at);
    return describeRange(live, options, { at, live: true });
  }
  const kept = rememberedRange();
  if (kept === undefined) return null;
  return describeRange(kept.range, options, { at: kept.at, live: false });
}
