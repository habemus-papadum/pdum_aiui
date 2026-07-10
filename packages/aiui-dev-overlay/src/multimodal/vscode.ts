/**
 * VS Code jump mode's target resolution: the pure DOM-reading half behind
 * "double-click an element, pick where to land in your editor".
 *
 * Reads the same attribution contract every other consumer (the shot
 * locator, the selection watcher) reads — `data-source-loc` stamped on host
 * JSX elements by the source-locator babel plugin, `data-cell` /
 * `data-cell-loc` stamped by CellView — and resolves a double-click target
 * into two **chains** of jump candidates for the picker (jump-picker.tsx):
 *
 *  - **elements** — the stamped ancestors of the click target, nearest →
 *    outermost: "which code *authored* this element", at increasing levels
 *    of containment. The nearest one is the picker's preselected default.
 *  - **cells** — the containing `data-cell` ancestors, nearest → outermost,
 *    each at the cell's **definition** site (`data-cell-loc` — the
 *    `cell(...)` call), falling back to the element's own JSX stamp, then to
 *    the first stamped descendant (where the cell's UI is authored — the
 *    same approximation the shot locator uses). The *usage* site needs no
 *    row of its own: it is, by construction, one of the element rows.
 *
 * Every target's `vscode://file/…` URL is **computed on the fly** from the
 * stamp and the plugin-injected source root; a target whose stamp can't be
 * resolved (no stamp, or no known root) still appears — with `url` absent —
 * so the picker can show it grayed instead of silently dropping it.
 *
 * Dependency-free and jsdom-testable, like selection.ts.
 */

/** One candidate the picker can commit: a place to open in the editor. */
export interface JumpTarget {
  kind: "element" | "cell";
  /** Row label: the element's tag name, or the cell's name. */
  label: string;
  /** The stamp backing the jump (`file:line[:col]`, app-root-relative or absolute). */
  loc?: string;
  /** The `vscode://file/…` deep link; absent when `loc` is missing or the root is unknown. */
  url?: string;
  /** The DOM element this row describes — drives the picker's on-page highlight. */
  el: Element;
}

/** Both chains at a click point, ready for the picker. */
export interface JumpTargets {
  elements: JumpTarget[];
  cells: JumpTarget[];
}

/** Chain caps: containment beyond this depth stops being a useful choice. */
const MAX_ELEMENT_TARGETS = 5;
const MAX_CELL_TARGETS = 4;

/**
 * The stamped-ancestor chain, nearest → outermost: walk outward from the
 * (usually unstamped) click target, collecting each `data-source-loc`
 * element. Consecutive duplicate stamps collapse (defensive — distinct JSX
 * elements carry distinct stamps), and the chain caps at
 * {@link MAX_ELEMENT_TARGETS}.
 */
export function elementChain(target: Element, sourceRoot: string | undefined): JumpTarget[] {
  const chain: JumpTarget[] = [];
  let el: Element | null = target.closest("[data-source-loc]");
  while (el !== null && chain.length < MAX_ELEMENT_TARGETS) {
    const loc = el.getAttribute("data-source-loc");
    if (loc !== null && loc !== "" && loc !== chain.at(-1)?.loc) {
      chain.push({
        kind: "element",
        label: el.tagName.toLowerCase(),
        loc,
        ...(urlFor(loc, sourceRoot) ?? {}),
        el,
      });
    }
    el = el.parentElement?.closest("[data-source-loc]") ?? null;
  }
  return chain;
}

/**
 * The containing-cell chain, nearest → outermost: every non-empty
 * `data-cell` ancestor of the click target (capped at
 * {@link MAX_CELL_TARGETS}), each resolved to its best stamp via
 * {@link cellSourceLoc}. A cell with no resolvable stamp still appears —
 * `loc`/`url` absent — so the picker can name it instead of hiding it.
 */
export function cellChain(target: Element, sourceRoot: string | undefined): JumpTarget[] {
  const chain: JumpTarget[] = [];
  for (let el: Element | null = target; el !== null; el = el.parentElement) {
    const name = el.getAttribute("data-cell");
    if (name === null || name === "") {
      continue;
    }
    const loc = cellSourceLoc(el);
    chain.push({
      kind: "cell",
      label: name,
      ...(loc !== undefined ? { loc } : {}),
      ...(loc !== undefined ? (urlFor(loc, sourceRoot) ?? {}) : {}),
      el,
    });
    if (chain.length >= MAX_CELL_TARGETS) {
      break;
    }
  }
  return chain;
}

/** Both chains at once — what the modality hands the picker on double-click. */
export function jumpTargets(target: Element, sourceRoot: string | undefined): JumpTargets {
  return {
    elements: elementChain(target, sourceRoot),
    cells: cellChain(target, sourceRoot),
  };
}

/**
 * A cell element's source stamp — THE shared resolution ladder (the shot
 * locator, the selection watcher, and the jump picker all route through
 * here). Best first: `data-cell-loc` (the cell's *definition* site — the
 * `cell(...)` call, stamped by CellView); the **live cell registry** (aiui-viz
 * mirrors name→loc at `window.__aiuiCells`), which is what lets the one
 * MANUAL attribution attribute — a bare `data-cell="name"` on a non-CellView
 * render — resolve to the full definition site; the element's own
 * `data-source-loc`; then the first stamped descendant (where the cell's UI
 * is authored — an approximation, but the right file to open first).
 */
export function cellSourceLoc(cellEl: Element): string | undefined {
  return (
    cellEl.getAttribute("data-cell-loc") ??
    registryCellLoc(cellEl.getAttribute("data-cell")) ??
    cellEl.getAttribute("data-source-loc") ??
    cellEl.querySelector("[data-source-loc]")?.getAttribute("data-source-loc") ??
    undefined
  );
}

/**
 * Definition site for a cell name from the live registry, when the page runs
 * aiui-viz. Structural and best-effort — the overlay never imports the
 * framework; a page without the bridge (or a foreign framework implementing
 * only the DOM contract) falls through to the stamp ladder.
 */
function registryCellLoc(name: string | null): string | undefined {
  if (!name) {
    return undefined;
  }
  try {
    const bridge = (
      window as unknown as { __aiuiCells?: { loc?: (n: string) => string | undefined } }
    ).__aiuiCells;
    return bridge?.loc?.(name) ?? undefined;
  } catch {
    return undefined; // a broken bridge must never break attribution
  }
}

/**
 * A `data-source-loc` / `data-cell-loc` stamp (`file:line[:col]`,
 * app-root-relative) as a `vscode://file/…` deep link, absolutized against
 * the plugin-injected source root. `undefined` when the stamp is relative
 * and no root is known — a relative path handed to VS Code would open
 * nothing.
 */
export function vscodeFileUrl(stamp: string, sourceRoot: string | undefined): string | undefined {
  const absolute = stamp.startsWith("/")
    ? stamp
    : sourceRoot !== undefined && sourceRoot !== ""
      ? `${sourceRoot.endsWith("/") ? sourceRoot : `${sourceRoot}/`}${stamp}`
      : undefined;
  if (absolute === undefined) {
    return undefined;
  }
  // encodeURI keeps `/` and `:` (the line:col suffix) intact while making
  // spaces and friends URL-safe for location.assign.
  return encodeURI(`vscode://file/${absolute.replace(/^\//, "")}`);
}

/** {@link vscodeFileUrl} as a spreadable `{ url }` fragment (or nothing). */
function urlFor(stamp: string, sourceRoot: string | undefined): { url: string } | undefined {
  const url = vscodeFileUrl(stamp, sourceRoot);
  return url !== undefined ? { url } : undefined;
}
