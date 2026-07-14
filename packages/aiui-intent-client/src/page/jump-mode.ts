/**
 * jump-mode.ts — jump-to-editor for instrumented pages, IN-REPO (ported from
 * the overlay's `multimodal/vscode.ts` + `jump-picker.tsx`, owner 2026-07-15;
 * the overlay stays frozen).
 *
 * The gesture: the panel's `j` (turn phase, aiui pages only) arms a ONE-SHOT
 * pick on the page — move highlights the nearest stamped element, click opens
 * the picker at that point: the stamped **element** ancestors (nearest →
 * outermost, "which code authored this") and the containing **cells** at
 * their definition sites. Pick a row and the page opens `vscode://file/…`.
 * Esc cancels; commit or cancel, the mode disarms (one-shot, like the region
 * drag).
 *
 * Unlike the overlay's picker this one is PLAIN DOM: it runs inside victim
 * pages via the evaluated ink bundle (CDP tier) or the content script (MV3),
 * where Solid's compile-time JSX is not available. The interaction contract
 * is the overlay's, kept exactly:
 *
 *   move   highlight the nearest stamped element under the pointer
 *   click  open the picker (chains at the click target)
 *   ↑/↓    move the selection through the openable rows (wraps)
 *   1–9    commit the numbered row directly
 *   Enter  commit the selected row
 *   Esc    dismiss (first the picker, then the mode)
 *   hover  moves the selection; click commits a row
 *
 * Rows that can't open (no stamp, or no known source root) still render,
 * grayed — a miss is NAMED, never silently absent.
 *
 * The chain logic reads the same attribution contract as every other
 * consumer: `data-source-loc` (the aiui plugin's dev stamps), `data-cell` /
 * `data-cell-loc` (CellView), the live `window.__aiuiCells` registry, and
 * `window.__AIUI__.sourceRoot` (the plugin's dev-only seed) to absolutize.
 * Pure functions, jsdom-testable.
 */

/** One candidate the picker can commit: a place to open in the editor. */
export interface JumpTarget {
  kind: "element" | "cell";
  /** Row label: the element's tag name, or the cell's name. */
  label: string;
  /** The stamp backing the jump (`file:line[:col]`, root-relative or absolute). */
  loc?: string;
  /** The `vscode://file/…` deep link; absent when unresolvable. */
  url?: string;
  /** The DOM element this row describes — drives the on-page highlight. */
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

/** The stamped-ancestor chain, nearest → outermost (duplicates collapse). */
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

/** The containing-cell chain, nearest → outermost, at definition sites. */
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

/** Both chains at once — what the pick hands the picker. */
export function jumpTargets(target: Element, sourceRoot: string | undefined): JumpTargets {
  return {
    elements: elementChain(target, sourceRoot),
    cells: cellChain(target, sourceRoot),
  };
}

/**
 * A cell element's best stamp — the shared resolution ladder: `data-cell-loc`
 * (the definition site), the live registry (`window.__aiuiCells`), the
 * element's own JSX stamp, then the first stamped descendant.
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

/** A stamp as a `vscode://file/…` deep link, absolutized against the root. */
export function vscodeFileUrl(stamp: string, sourceRoot: string | undefined): string | undefined {
  const absolute = stamp.startsWith("/")
    ? stamp
    : sourceRoot !== undefined && sourceRoot !== ""
      ? `${sourceRoot.endsWith("/") ? sourceRoot : `${sourceRoot}/`}${stamp}`
      : undefined;
  if (absolute === undefined) {
    return undefined;
  }
  // encodeURI keeps `/` and `:` (the line:col suffix) intact.
  return encodeURI(`vscode://file/${absolute.replace(/^\//, "")}`);
}

function urlFor(stamp: string, sourceRoot: string | undefined): { url: string } | undefined {
  const url = vscodeFileUrl(stamp, sourceRoot);
  return url !== undefined ? { url } : undefined;
}

/** The plugin's dev-only seed, read live (the page may have none in prod). */
function pageSourceRoot(): string | undefined {
  const root = (window as unknown as { __AIUI__?: { sourceRoot?: string } }).__AIUI__?.sourceRoot;
  return typeof root === "string" && root !== "" ? root : undefined;
}

// ── the one-shot pick mode + plain-DOM picker ────────────────────────────────

const HOST_ID = "__aiui-intent-jump";

interface JumpState {
  host: HTMLElement;
  highlight: HTMLElement;
  picker: HTMLElement;
  teardown: () => void;
}

let mode: JumpState | undefined;

/** Leave jump mode (idempotent): picker, highlight, listeners — all gone. */
export function disarmJump(): void {
  mode?.teardown();
  mode = undefined;
}

/**
 * Enter the one-shot pick (re-arm replaces). `open` is injectable for tests —
 * the default hands the `vscode://` link to the browser.
 */
export function armJump(open: (url: string) => void = (url) => window.location.assign(url)): void {
  disarmJump();
  document.getElementById(HOST_ID)?.remove(); // a stale host from an earlier client

  const host = document.createElement("div");
  host.id = HOST_ID;
  const style = document.createElement("style");
  style.textContent =
    `#${HOST_ID}-box{position:fixed;z-index:2147483645;pointer-events:none;display:none;` +
    "border:2px solid #7ee0a3;background:rgba(126,224,163,.12);border-radius:2px;}" +
    `#${HOST_ID}-picker{position:fixed;z-index:2147483646;display:none;min-width:260px;max-width:420px;` +
    "background:#1c1f26;color:#e6e9ef;border:1px solid #3a3f4b;border-radius:8px;padding:6px;" +
    "font:12px ui-monospace,SFMono-Regular,Menlo,monospace;box-shadow:0 8px 24px rgba(0,0,0,.45);}" +
    `#${HOST_ID}-picker .jgroup{opacity:.6;padding:4px 6px 2px;font-size:10px;text-transform:uppercase;letter-spacing:.08em;}` +
    `#${HOST_ID}-picker .jrow{display:flex;gap:8px;align-items:baseline;padding:3px 6px;border-radius:5px;cursor:pointer;}` +
    `#${HOST_ID}-picker .jrow.active{background:#2d3550;}` +
    `#${HOST_ID}-picker .jrow.disabled{opacity:.4;cursor:default;}` +
    `#${HOST_ID}-picker .jrow b{min-width:1em;color:#7ee0a3;font-weight:600;}` +
    `#${HOST_ID}-picker .jloc{opacity:.55;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;text-align:right;}` +
    `#${HOST_ID}-picker .jhint{opacity:.5;padding:5px 6px 1px;font-size:10px;border-top:1px solid #2a2f3a;margin-top:4px;}`;
  const highlight = document.createElement("div");
  highlight.id = `${HOST_ID}-box`;
  const picker = document.createElement("div");
  picker.id = `${HOST_ID}-picker`;
  host.append(style, highlight, picker);
  (document.body ?? document.documentElement).appendChild(host);

  // The picker's tiny selection model (the overlay's, minus Solid).
  let rows: JumpTarget[] = [];
  let openable: number[] = [];
  let selected = -1;

  const boxTo = (el: Element | undefined): void => {
    if (el === undefined) {
      highlight.style.display = "none";
      return;
    }
    const box = el.getBoundingClientRect();
    highlight.style.display = "block";
    highlight.style.left = `${box.left}px`;
    highlight.style.top = `${box.top}px`;
    highlight.style.width = `${box.width}px`;
    highlight.style.height = `${box.height}px`;
  };

  const renderPicker = (): void => {
    const digits = new Map(openable.slice(0, 9).map((flat, i) => [flat, i + 1]));
    const section = (title: string, kind: JumpTarget["kind"]): string => {
      const group = rows
        .map((target, flat) => ({ target, flat }))
        .filter((row) => row.target.kind === kind);
      if (group.length === 0) {
        return "";
      }
      const items = group
        .map(({ target, flat }) => {
          const digit = digits.get(flat);
          const classes = `jrow${flat === selected ? " active" : ""}${digit === undefined ? " disabled" : ""}`;
          return (
            `<div class="${classes}" data-row="${flat}"><b>${digit ?? ""}</b>` +
            `<span>${escapeHtml(target.label)}</span>` +
            `<span class="jloc">${escapeHtml(target.loc ?? "no source location")}</span></div>`
          );
        })
        .join("");
      return `<div class="jgroup">${escapeHtml(title)}</div>${items}`;
    };
    const miss =
      rows.length === 0
        ? "no source location on or around this element"
        : openable.length === 0
          ? rows.some((t) => t.loc !== undefined)
            ? "source root unknown — can't build editor links"
            : "no source location recorded for anything here"
          : "↑↓ pick · 1–9 jump · ⏎ open · esc close";
    picker.innerHTML = `${section("element", "element")}${section("cell — defined at", "cell")}<div class="jhint">${miss}</div>`;
    boxTo(selected >= 0 ? rows[selected]?.el : undefined);
  };

  const openAt = (targets: JumpTargets, at: { x: number; y: number }): void => {
    rows = [...targets.elements, ...targets.cells];
    openable = rows.flatMap((t, i) => (t.url !== undefined ? [i] : []));
    selected = openable[0] ?? -1;
    renderPicker();
    picker.style.display = "block";
    const box = picker.getBoundingClientRect();
    picker.style.left = `${Math.min(at.x, Math.max(8, window.innerWidth - box.width - 8))}px`;
    picker.style.top = `${Math.min(at.y + 8, Math.max(8, window.innerHeight - box.height - 8))}px`;
  };

  const commit = (flat: number): void => {
    const url = rows[flat]?.url;
    disarmJump();
    if (url !== undefined) {
      open(url);
    }
  };

  const pickerOpen = (): boolean => picker.style.display === "block";

  const onMove = (event: MouseEvent): void => {
    if (pickerOpen()) {
      return;
    }
    const el = (event.target as Element | null)?.closest?.("[data-source-loc], [data-cell]");
    boxTo(el ?? undefined);
  };
  const onClick = (event: MouseEvent): void => {
    event.preventDefault();
    event.stopImmediatePropagation();
    const target = event.target as Element | null;
    if (pickerOpen()) {
      // Inside the picker: a row commits; anywhere else dismisses the mode.
      const row = target?.closest?.("[data-row]");
      const flat =
        row === null || row === undefined ? undefined : Number(row.getAttribute("data-row"));
      if (flat !== undefined && openable.includes(flat)) {
        commit(flat);
      } else if (target === null || !picker.contains(target)) {
        disarmJump();
      }
      return;
    }
    if (target === null) {
      return;
    }
    openAt(jumpTargets(target, pageSourceRoot()), { x: event.clientX, y: event.clientY });
  };
  const onOver = (event: MouseEvent): void => {
    if (!pickerOpen()) {
      return;
    }
    const row = (event.target as Element | null)?.closest?.("[data-row]");
    const flat =
      row === null || row === undefined ? undefined : Number(row.getAttribute("data-row"));
    if (flat !== undefined && openable.includes(flat) && flat !== selected) {
      selected = flat;
      renderPicker();
    }
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopImmediatePropagation();
      disarmJump();
      return;
    }
    if (!pickerOpen()) {
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (openable.length > 0) {
        const delta = event.key === "ArrowDown" ? 1 : -1;
        const at = openable.indexOf(selected);
        selected = openable[(at + delta + openable.length) % openable.length];
        renderPicker();
      }
    } else if (event.key === "Enter") {
      if (selected >= 0) {
        commit(selected);
      }
    } else if (/^[1-9]$/.test(event.key)) {
      const flat = openable[Number(event.key) - 1];
      if (flat !== undefined) {
        commit(flat);
      }
    }
  };

  document.addEventListener("mousemove", onMove, true);
  document.addEventListener("click", onClick, true);
  document.addEventListener("mouseover", onOver, true);
  document.addEventListener("keydown", onKey, true);

  mode = {
    host,
    highlight,
    picker,
    teardown: () => {
      document.removeEventListener("mousemove", onMove, true);
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("mouseover", onOver, true);
      document.removeEventListener("keydown", onKey, true);
      host.remove();
    },
  };
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
