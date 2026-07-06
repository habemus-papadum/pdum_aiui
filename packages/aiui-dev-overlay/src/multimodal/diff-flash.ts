/**
 * The reusable diff-flash: the pink/green word-diff moment used everywhere a
 * piece of text is *revised in front of the user* — a correction patch
 * landing in the transcript, a streaming STT model rewriting its own partial
 * hypothesis, a spoken phrase folding into the correction box. One visual
 * language for "this text just changed, here's how", built on the pipeline's
 * {@link wordDiff} (LCS) and the `mm-diff-del` / `mm-diff-add` styles.
 *
 * Two layers:
 *  - {@link runsFragment} — the pure-ish primitive: before/after → a DOM
 *    fragment of styled runs. Hosts that manage their own render cycles (the
 *    transcript preview re-renders whole pieces) use this directly.
 *  - {@link LiveDiffText} — a self-contained live text line: call `update`
 *    with each new cumulative text; extensions render instantly, revisions
 *    flash the diff and settle to clean text after `flashMs`. This is what a
 *    streaming surface (the correction box's live zone) mounts.
 */
import { type DiffRun, wordDiff } from "../intent-pipeline";

/** Default settle delay for a revision flash (streaming revisions come fast —
 * shorter than the correction-patch flash so the tail can't lag the stream). */
const DEFAULT_LIVE_FLASH_MS = 450;

/**
 * True when `after` merely extends `before` (the common streaming case: new
 * words appended). Extensions don't flash — only *revisions* do, or every
 * delta would strobe.
 */
export function isExtension(before: string, after: string): boolean {
  return after.startsWith(before);
}

/** Already-computed runs → a fragment of plain/`mm-diff-del`/`mm-diff-add` spans. */
export function renderRuns(runs: DiffRun[]): DocumentFragment {
  const fragment = document.createDocumentFragment();
  for (const run of runs) {
    const part = document.createElement("span");
    if (run.kind !== "same") {
      part.className = `mm-diff-${run.kind}`;
    }
    part.textContent = `${run.text} `;
    fragment.append(part);
  }
  return fragment;
}

/** Before/after → a fragment of plain/`mm-diff-del`/`mm-diff-add` runs. */
export function runsFragment(before: string, after: string): DocumentFragment {
  return renderRuns(wordDiff(before, after));
}

/**
 * A live-updating text line with revision flashes. Owns its host's children;
 * the host element (and its styling) belongs to the caller.
 */
export class LiveDiffText {
  private text = "";
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly host: HTMLElement,
    private readonly flashMs: () => number = () => DEFAULT_LIVE_FLASH_MS,
  ) {}

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
      this.settle();
      return;
    }
    // A revision: the model (or a correction) rewrote earlier words.
    this.clearTimer();
    this.host.replaceChildren(runsFragment(before, next));
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
