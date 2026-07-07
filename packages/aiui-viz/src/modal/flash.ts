/**
 * The reusable diff-flash: the pink/green word-diff moment used everywhere a
 * piece of text is *revised in front of the user* — a correction patch
 * landing in a transcript, a streaming STT model rewriting its own partial
 * hypothesis, a spoken phrase folding into an editor. One visual language
 * (and ONE tempo) for "this text just changed, here's how" — the moment two
 * surfaces animate changes differently, users stop trusting either
 * (modal-interaction-lessons §1).
 *
 * Two layers:
 *  - {@link runsFragment} — the pure-ish primitive: before/after → a DOM
 *    fragment of styled runs. Hosts that manage their own render cycles use
 *    this directly.
 *  - {@link LiveDiffText} — a self-contained live text line: call `update`
 *    with each new cumulative text; extensions render instantly, revisions
 *    flash the diff and settle to clean text after `flashMs`. The anti-strobe
 *    rule: only rewrites animate, appends never do.
 *
 * The run class names ship as options with the historical defaults
 * ({@link DEFAULT_DIFF_CLASSES} — the overlay's `mm-` names) so extraction
 * changed nothing for existing surfaces; new surfaces may restyle but should
 * keep the house tempo ({@link LIVE_FLASH_MS} / {@link SETTLE_FLASH_MS}) so
 * all aiui text animates at one speed.
 */
import { type DiffRun, wordDiff } from "./diff";

/** Settle delay for a *streaming* revision flash — shorter than the
 * correction-patch tempo so the tail can't lag the stream. */
export const LIVE_FLASH_MS = 450;

/** Settle delay for a *discrete* revision flash (a correction patch landing,
 * an undo restore) — long enough to read what changed. */
export const SETTLE_FLASH_MS = 750;

/** CSS classes stamped on non-"same" runs. */
export interface DiffRunClasses {
  del: string;
  add: string;
}

/** The historical (overlay) class names; restyle per surface if you must. */
export const DEFAULT_DIFF_CLASSES: DiffRunClasses = {
  del: "mm-diff-del",
  add: "mm-diff-add",
};

/**
 * True when `after` merely extends `before` (the common streaming case: new
 * words appended). Extensions don't flash — only *revisions* do, or every
 * delta would strobe.
 */
export function isExtension(before: string, after: string): boolean {
  return after.startsWith(before);
}

/** Already-computed runs → a fragment of plain/del/add spans. */
export function renderRuns(
  runs: DiffRun[],
  classes: DiffRunClasses = DEFAULT_DIFF_CLASSES,
): DocumentFragment {
  const fragment = document.createDocumentFragment();
  for (const run of runs) {
    const part = document.createElement("span");
    if (run.kind !== "same") {
      part.className = classes[run.kind];
    }
    part.textContent = `${run.text} `;
    fragment.append(part);
  }
  return fragment;
}

/** Before/after → a fragment of plain/del/add runs. */
export function runsFragment(
  before: string,
  after: string,
  classes: DiffRunClasses = DEFAULT_DIFF_CLASSES,
): DocumentFragment {
  return renderRuns(wordDiff(before, after), classes);
}

export interface LiveDiffTextOptions {
  /** Settle delay per revision; defaults to the house {@link LIVE_FLASH_MS}. */
  flashMs?: () => number;
  classes?: DiffRunClasses;
}

/**
 * A live-updating text line with revision flashes. Owns its host's children;
 * the host element (and its styling) belongs to the caller.
 */
export class LiveDiffText {
  private text = "";
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly flashMs: () => number;
  private readonly classes: DiffRunClasses;

  constructor(
    private readonly host: HTMLElement,
    options: LiveDiffTextOptions = {},
  ) {
    this.flashMs = options.flashMs ?? (() => LIVE_FLASH_MS);
    this.classes = options.classes ?? DEFAULT_DIFF_CLASSES;
  }

  /** The current (clean) text. */
  get value(): string {
    return this.text;
  }

  /** Feed the next cumulative text; revisions flash, extensions just render. */
  update(next: string): void {
    const before = this.text;
    this.text = next;
    if (before === next) {
      return;
    }
    if (before === "" || isExtension(before, next)) {
      // An extension arriving mid-flash also cancels the pending settle: the
      // timer would only re-write the same text later, but a live timer is a
      // live timer.
      this.clearTimer();
      this.settle();
      return;
    }
    // A revision: the model (or a correction) rewrote earlier words.
    this.clearTimer();
    this.host.replaceChildren(runsFragment(before, next, this.classes));
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.settle();
    }, this.flashMs());
  }

  /** Reset to empty (a new segment / the surface closed). */
  clear(): void {
    this.clearTimer();
    this.text = "";
    this.host.replaceChildren();
  }

  private settle(): void {
    this.host.textContent = this.text;
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}
