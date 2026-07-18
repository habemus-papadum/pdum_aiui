/**
 * The selection watcher: page-side machinery behind the "select something on
 * the page, then ask the intent tool about it" modality.
 *
 * Design decisions (settled in the retired dev overlay and verified empirically
 * in the live demo — git history: its `handoff/selection-intent.md`):
 *  - **The Selection API is enough — no extension, no app-side machinery.**
 *    Page code (this runtime, injected everywhere by the Vite plugin) reads the
 *    selected text, its geometry (`getClientRects`, for later screenshot
 *    annotation), and the *same* attribution the screenshot/`locate` pipeline
 *    uses: `data-source-loc` / `data-cell` via `closest()` on the selection's
 *    start element. Selection is just a third consumer of that DOM contract.
 *  - **Snapshot, don't read-through.** The one real trap: the moment focus
 *    moves into the intent widget's textarea, the document selection reads
 *    empty. So we keep the LAST non-collapsed selection as a snapshot, updated
 *    on a debounced `selectionchange`; an empty/collapsed selection never
 *    *clears* the snapshot (only {@link SelectionWatcher.clear} does — dismiss
 *    or post-submit). That is what survives the focus steal.
 *  - **Equations.** Selected KaTeX is DOM soup; recover the TeX from a
 *    `data-tex` wrapper (the demo's math component stamps it) or, failing that,
 *    KaTeX's own `<annotation encoding="application/x-tex">` MathML fallback.
 *  - **Dependency-free and jsdom-testable.** No layout is required to build a
 *    snapshot (rects degrade to `[]` where `getClientRects` is unavailable, as
 *    in jsdom); attribution and TeX recovery are pure DOM reads.
 *
 * Not handled (documented limitations, not MVP): selections inside *app-side*
 * open shadow roots need `Selection.getComposedRanges` (the reference apps use
 * none); multi-range selections (Firefox Ctrl-select) take range 0.
 */

import { cellSourceLoc } from "./vscode";

/** A highlight rectangle in viewport coordinates (from `getClientRects`). */
export interface SelectionRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A frozen record of one on-screen selection, enough to ask an agent about it. */
export interface SelectionSnapshot {
  /** The selected text, trimmed and capped at {@link MAX_TEXT} chars. */
  text: string;
  /** Per-line highlight rectangles (viewport coords), capped at {@link MAX_RECTS}. */
  rects: SelectionRect[];
  /** `data-source-loc` (`file:line:col`) of the selection's start element, if stamped. */
  sourceLoc?: string;
  /** `data-cell` (dataflow node) of the selection's start element, if stamped. */
  cell?: string;
  /** That cell's definition site (`file:line` — the `cell(...)` call), if resolvable. */
  cellLoc?: string;
  /** TeX source when the selection is rendered mathematics. */
  tex?: string;
  /** `location.href` when the snapshot was taken. */
  url: string;
  /** Epoch ms of capture (used for TTL expiry). */
  at: number;
}

/** Handle over a running selection watcher. */
export interface SelectionWatcher {
  /** The current snapshot, or undefined when there is none / it has expired. */
  snapshot(): SelectionSnapshot | undefined;
  /** Drop the current snapshot (explicit dismiss, or after a submission consumes it). */
  clear(): void;
  /**
   * Add a node whose selections to ignore, after the fact — for UI surfaces
   * created later than the watcher (the host's page-level layers: selecting
   * in the transcript preview must never become the "app selection").
   */
  addIgnored(node: Node): void;
  /** Stop listening and release everything. Idempotent. */
  dispose(): void;
}

export interface SelectionWatcherOptions {
  /**
   * Nodes whose selections to ignore — the intent tool's own shadow host, so
   * interacting with the widget never captures a "selection" of the widget.
   */
  ignoreWithin?: Node[];
  /** Called whenever the snapshot changes (a new capture, or a clear). */
  onChange?: (snapshot: SelectionSnapshot | undefined) => void;
  /** Debounce for the `selectionchange` listener, in ms (default 150). */
  debounceMs?: number;
  /** How long a snapshot stays valid, in ms (default 120000). */
  ttlMs?: number;
}

/** Trimmed selection text is capped here (a prompt block, not a document). */
const MAX_TEXT = 2000;
/** At most this many highlight rectangles ride a snapshot. */
const MAX_RECTS = 20;
const DEFAULT_DEBOUNCE_MS = 150;
const DEFAULT_TTL_MS = 120_000;

/** The element to attribute a range from: its start element (text → parent). */
function startElementOf(range: Range): Element | null {
  const node = range.startContainer;
  return node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
}

/** Recover the TeX behind a selection: a `data-tex` wrapper, else KaTeX's MathML. */
function texOf(startEl: Element | null): string | undefined {
  if (startEl === null) {
    return undefined;
  }
  const stamped = startEl.closest("[data-tex]")?.getAttribute("data-tex");
  if (stamped != null) {
    return stamped;
  }
  const annotation = startEl
    .closest(".katex")
    ?.querySelector('annotation[encoding="application/x-tex"]')?.textContent;
  return annotation ?? undefined;
}

/** Collect up to {@link MAX_RECTS} client rects; `[]` where `getClientRects` is absent (jsdom). */
function rectsOf(range: Range): SelectionRect[] {
  const out: SelectionRect[] = [];
  // jsdom implements Element.getClientRects but not Range.getClientRects.
  if (typeof range.getClientRects !== "function") {
    return out;
  }
  const list = range.getClientRects();
  for (let i = 0; i < list.length && out.length < MAX_RECTS; i++) {
    const r = list[i];
    out.push({ x: r.x, y: r.y, w: r.width, h: r.height });
  }
  return out;
}

/** Build a snapshot from a non-collapsed range and its (already-trimmed) text. */
function buildSnapshot(range: Range, text: string): SelectionSnapshot {
  const startEl = startElementOf(range);
  const sourceLoc = startEl?.closest("[data-source-loc]")?.getAttribute("data-source-loc");
  const cellEl = startEl?.closest("[data-cell]") ?? null;
  const cell = cellEl?.getAttribute("data-cell");
  // The cell's DEFINITION site (the `cell(...)` call): the same resolution
  // the shot locator and the jump picker use — data-cell-loc first, then
  // the JSX-stamp approximation.
  const cellLoc = cellEl !== null && cell != null ? cellSourceLoc(cellEl) : undefined;
  const tex = texOf(startEl);
  return {
    text: text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text,
    rects: rectsOf(range),
    ...(sourceLoc != null ? { sourceLoc } : {}),
    ...(cell != null ? { cell } : {}),
    ...(cellLoc !== undefined ? { cellLoc } : {}),
    ...(tex !== undefined ? { tex } : {}),
    url: typeof location !== "undefined" ? location.href : "",
    at: Date.now(),
  };
}

/** True when `range` sits inside any of the ignored nodes. */
function isWithinIgnored(range: Range, ignore: Node[] | undefined): boolean {
  if (ignore === undefined || ignore.length === 0) {
    return false;
  }
  const node = range.commonAncestorContainer;
  return ignore.some((ig) => ig === node || ig.contains(node));
}

const NOOP_WATCHER: SelectionWatcher = {
  snapshot: () => undefined,
  clear() {},
  addIgnored() {},
  dispose() {},
};

/**
 * Install a debounced `selectionchange` watcher that keeps the last
 * non-collapsed selection as a {@link SelectionSnapshot}. No-ops (returns a
 * safe handle) without a DOM. See the module doc for the design rationale.
 */
export function installSelectionWatcher(opts: SelectionWatcherOptions = {}): SelectionWatcher {
  if (typeof document === "undefined" || typeof document.addEventListener !== "function") {
    return NOOP_WATCHER;
  }
  const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  // Own copy: addIgnored grows it after creation without mutating the caller's.
  const ignored = [...(opts.ignoreWithin ?? [])];

  let current: SelectionSnapshot | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const notify = (): void => opts.onChange?.(current);

  const snapshot = (): SelectionSnapshot | undefined => {
    // Lazy TTL: an untouched selection older than the TTL is stale. Don't fire
    // onChange here — this is a read, and a re-render already re-reads it.
    if (current !== undefined && Date.now() - current.at > ttlMs) {
      current = undefined;
    }
    return current;
  };

  const clear = (): void => {
    if (current !== undefined) {
      current = undefined;
      notify();
    }
  };

  const capture = (): void => {
    timer = undefined;
    const sel = typeof window !== "undefined" ? window.getSelection?.() : null;
    if (sel == null || sel.rangeCount === 0 || sel.isCollapsed) {
      // Empty/collapsed does NOT clear the snapshot: the focus steal into the
      // widget's textarea is exactly the moment we must survive.
      return;
    }
    const range = sel.getRangeAt(0);
    const text = sel.toString().trim();
    if (text === "" || isWithinIgnored(range, ignored)) {
      return;
    }
    current = buildSnapshot(range, text);
    notify();
  };

  const onSelectionChange = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    timer = setTimeout(capture, debounceMs);
  };

  document.addEventListener("selectionchange", onSelectionChange);

  return {
    snapshot,
    clear,
    addIgnored(node: Node): void {
      ignored.push(node);
    },
    dispose(): void {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      document.removeEventListener("selectionchange", onSelectionChange);
      current = undefined;
    },
  };
}
