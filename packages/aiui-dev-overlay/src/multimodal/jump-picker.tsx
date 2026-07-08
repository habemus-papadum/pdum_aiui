/**
 * The jump picker — VS Code jump mode's two-step popup.
 *
 * A double-click in jump mode doesn't navigate; it opens THIS: the hierarchy
 * of jump candidates at the click point — the stamped **element** ancestors
 * (nearest → outermost) and the containing **cells** at their definition
 * sites (vscode.ts builds both chains) — so the user picks where to land
 * instead of the gesture guessing. The nearest element is preselected: one
 * double-click + Enter is still the fast path.
 *
 * Interaction contract (decisions stay in the modality's dispatch; keys stay
 * in the pure keymap's jump-picker layer — this file is presentation plus
 * the tiny selection model the dispatch drives):
 *
 *   ↑/↓    move the selection through the openable rows (wraps)
 *   1–9    commit the numbered row directly
 *   Enter  commit the selected row
 *   Esc    dismiss (still in jump mode)
 *   click  commit a row / hover moves the selection
 *
 * As the selection moves, the corresponding element's bounding box lights up
 * on the page (the `mm-jump-highlight` box) — containment stops being
 * abstract, you SEE which box each row is. Rows that can't be opened (a cell
 * with no recorded definition, or no known source root) still render, grayed
 * and un-selectable, so a miss is always NAMED rather than silently absent.
 *
 * Solid renders the content inside a vanilla class facade (the config-strip
 * pattern, proposal B2.2): the signal lives INSIDE the render root; the
 * `.visible` classList toggle and the `open` getter stay synchronous on the
 * light-DOM root, because the keymap reads `open` mid-keydown, before any
 * flush.
 */
import { render } from "@solidjs/web";
import { createSignal, For, Show } from "solid-js";
import type { KeyCommand } from "../intent-pipeline";
import type { JumpTarget, JumpTargets } from "./vscode";

/** One rendered row: its target, flat index, and digit (openable rows only). */
interface PickerRow {
  target: JumpTarget;
  flat: number;
  digit?: number;
}

interface PickerView {
  rows: PickerRow[];
  /** Flat index of the selected row; -1 when nothing is selectable. */
  selected: number;
  /** The named miss / hint replacing the footer when nothing can open. */
  message?: string;
}

/** Distance the popup sits below the double-click point, in px. */
const OFFSET_Y = 8;
/** Margin kept between the popup and the viewport edges when clamping. */
const VIEWPORT_MARGIN = 8;

export class JumpPicker {
  /** The popup itself — position: fixed, joins the page-level layers. */
  readonly root: HTMLDivElement;
  /** The on-page bounding-box highlight for the selected row's element. */
  readonly highlight: HTMLDivElement;

  /** The flat candidate list (elements then cells) behind the current open. */
  private rows: JumpTarget[] = [];
  /** Flat indices of rows that can actually be opened (have a URL). */
  private openable: number[] = [];
  /** Flat index of the selection; -1 when nothing is selectable. */
  private selected = -1;
  private readonly setView: (view: PickerView | undefined) => void;

  /**
   * `onCommand` routes row clicks into the SAME dispatch the keymap feeds —
   * the picker stays decision-free about what a commit *does*.
   */
  constructor(onCommand?: (command: KeyCommand) => void) {
    this.root = document.createElement("div");
    this.root.className = "mm-jump-picker";
    this.highlight = document.createElement("div");
    this.highlight.className = "mm-jump-highlight";

    if (onCommand) {
      this.root.addEventListener("click", (event) => {
        const flat = rowIndexOf(event.target);
        if (flat === undefined) {
          return;
        }
        const index = this.openable.indexOf(flat);
        if (index !== -1) {
          onCommand({ cmd: "jump-commit", index });
        }
      });
    }
    // Hover moves the selection (openable rows only) — the same model the
    // arrows drive, so the highlight box always tracks one selection.
    this.root.addEventListener("mouseover", (event) => {
      const flat = rowIndexOf(event.target);
      if (flat !== undefined && this.openable.includes(flat) && flat !== this.selected) {
        this.selected = flat;
        this.pushView();
      }
    });

    let setView: ((view: PickerView | undefined) => void) | undefined;
    const Picker = () => {
      const [view, set] = createSignal<PickerView | undefined>(undefined);
      setView = (next) => set(next);
      const rowClass = (row: PickerRow): string => {
        let classes = "mm-jump-row";
        if (row.flat === view()?.selected) {
          classes += " active";
        }
        if (row.digit === undefined) {
          classes += " disabled";
        }
        return classes;
      };
      const group = (kind: JumpTarget["kind"]): PickerRow[] =>
        (view()?.rows ?? []).filter((row) => row.target.kind === kind);
      const section = (title: string, rows: PickerRow[]) => (
        <Show when={rows.length > 0}>
          <div class="mm-jump-group">{title}</div>
          <For each={rows}>
            {(row) => (
              <div class={rowClass(row)} data-row={row.flat}>
                <b>{row.digit ?? ""}</b>
                <span class="mm-jump-label">{row.target.label}</span>
                <span class="mm-jump-loc">{row.target.loc ?? "no source location"}</span>
              </div>
            )}
          </For>
        </Show>
      );
      return (
        <Show when={view() !== undefined}>
          {section("element", group("element"))}
          {section("cell — defined at", group("cell"))}
          <div class="mm-jump-hint">
            {view()?.message ?? "↑↓ pick · 1–9 jump · ⏎ open · esc close"}
          </div>
        </Show>
      );
    };
    render(Picker, this.root);
    if (!setView) {
      throw new Error("jump picker render did not capture its setter");
    }
    this.setView = setView;
  }

  /** Synchronous — the keymap's jump-picker layer reads this mid-keydown. */
  get open(): boolean {
    return this.root.classList.contains("visible");
  }

  /** Open (or re-open) at a double-click point with fresh chains. */
  openAt(targets: JumpTargets, at: { x: number; y: number }): void {
    this.rows = [...targets.elements, ...targets.cells];
    this.openable = this.rows.flatMap((t, i) => (t.url !== undefined ? [i] : []));
    this.selected = this.openable[0] ?? -1;
    this.pushView();
    this.root.style.left = `${at.x}px`;
    this.root.style.top = `${at.y + OFFSET_Y}px`;
    this.root.classList.add("visible");
    // Clamp into the viewport once the content has a size — a frame later.
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => {
        if (!this.open) {
          return;
        }
        const box = this.root.getBoundingClientRect();
        const left = Math.min(
          at.x,
          Math.max(VIEWPORT_MARGIN, window.innerWidth - box.width - VIEWPORT_MARGIN),
        );
        const top = Math.min(
          at.y + OFFSET_Y,
          Math.max(VIEWPORT_MARGIN, window.innerHeight - box.height - VIEWPORT_MARGIN),
        );
        this.root.style.left = `${left}px`;
        this.root.style.top = `${top}px`;
      });
    }
  }

  hide(): void {
    this.root.classList.remove("visible");
    this.highlight.classList.remove("visible");
  }

  /** Step the selection through the openable rows, wrapping at the ends. */
  move(delta: 1 | -1): void {
    if (this.openable.length === 0) {
      return;
    }
    const position = this.openable.indexOf(this.selected);
    const next = (position + delta + this.openable.length) % this.openable.length;
    this.selected = this.openable[next];
    this.pushView();
  }

  /** The row Enter commits, or undefined when nothing is selectable. */
  selectedTarget(): JumpTarget | undefined {
    return this.selected >= 0 ? this.rows[this.selected] : undefined;
  }

  /** The row a digit commits (0-based over the openable rows). */
  targetAt(index: number): JumpTarget | undefined {
    const flat = this.openable[index];
    return flat !== undefined ? this.rows[flat] : undefined;
  }

  /** Push the model into the Solid view and re-sync the on-page highlight. */
  private pushView(): void {
    const digits = new Map(this.openable.slice(0, 9).map((flat, i) => [flat, i + 1]));
    this.setView({
      rows: this.rows.map((target, flat) => ({
        target,
        flat,
        ...(digits.has(flat) ? { digit: digits.get(flat) } : {}),
      })),
      selected: this.selected,
      ...(this.missMessage() !== undefined ? { message: this.missMessage() } : {}),
    });
    this.syncHighlight();
  }

  /** The named miss shown in the footer when nothing can be opened. */
  private missMessage(): string | undefined {
    if (this.rows.length === 0) {
      return "no source location on or around this element";
    }
    if (this.openable.length === 0) {
      return this.rows.some((t) => t.loc !== undefined)
        ? "source root unknown — can't build editor links"
        : "no source location recorded for anything here";
    }
    return undefined;
  }

  /** Track the selected row's element with the on-page bounding box. */
  private syncHighlight(): void {
    const target = this.selectedTarget();
    if (target === undefined) {
      this.highlight.classList.remove("visible");
      return;
    }
    const box = target.el.getBoundingClientRect();
    this.highlight.style.left = `${box.left}px`;
    this.highlight.style.top = `${box.top}px`;
    this.highlight.style.width = `${box.width}px`;
    this.highlight.style.height = `${box.height}px`;
    this.highlight.classList.add("visible");
  }
}

/** The flat row index under an event target, from the `data-row` stamp. */
function rowIndexOf(target: EventTarget | null): number | undefined {
  const row = (target as Element | null)?.closest?.("[data-row]");
  const flat = row?.getAttribute("data-row");
  return flat !== null && flat !== undefined ? Number(flat) : undefined;
}
