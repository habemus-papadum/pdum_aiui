/**
 * types.ts — the walkthrough data model (Tier 3 of the code-reader proposal).
 *
 * Author-agnostic on purpose: the same stepper serves a human-written
 * onboarding tour, a release-notes tour from a commit range, or the natural fit
 * — an agent's "explain what I just did" tour authored through the reader's
 * `create_walkthrough` agent tool. A step pins prose (and optional narration /
 * before-after diff) to a source range; the reader reveals the range in Monaco
 * as you click through.
 */

/** Zero-based line, zero-based column — LSP's `Position`, which is what we get
 * from the language server and hand back to Monaco (Monaco is 1-based, so the
 * reader adds 1 at the boundary). Keeping the model in LSP coordinates means a
 * range produced by a `documentSymbol` result drops straight into a step. */
export interface Pos {
  line: number;
  character: number;
}

export interface Range {
  start: Pos;
  end: Pos;
}

export interface WalkthroughStep {
  /** Project-relative POSIX path, same space as {@link FileEntry.path}. */
  file: string;
  /** The range revealed + highlighted in the reader when you arrive. */
  range: Range;
  title?: string;
  /** Shown in the step popover. Markdown-ish plain text. */
  prose: string;
  /** Optional text read aloud (TTS) — wired to the channel's speak seam later. */
  narration?: string;
  /** Optional "what changed here" — a simple before/after the stepper renders as a diff. */
  diff?: { before: string; after: string };
}

export interface Walkthrough {
  id: string;
  title: string;
  steps: WalkthroughStep[];
  /** Who authored it — `"agent"`, a human handle, `"release-notes"`, … */
  createdBy?: string;
  /** ISO timestamp; set by the store on save. */
  createdAt?: string;
}

/** The cheap listing shape (no step bodies) for the reader's tour picker. */
export interface WalkthroughSummary {
  id: string;
  title: string;
  stepCount: number;
  createdBy?: string;
  createdAt?: string;
}

export function summarize(w: Walkthrough): WalkthroughSummary {
  return {
    id: w.id,
    title: w.title,
    stepCount: w.steps.length,
    ...(w.createdBy ? { createdBy: w.createdBy } : {}),
    ...(w.createdAt ? { createdAt: w.createdAt } : {}),
  };
}
