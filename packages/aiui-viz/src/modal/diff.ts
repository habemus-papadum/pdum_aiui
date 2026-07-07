/**
 * Word-level diff, merged into runs for rendering — the computation half of
 * the "one visual language for text changed in front of you" rule (see
 * ../../handoff/modal-interaction-lessons.md §1). Lifted verbatim from the
 * dev overlay's intent pipeline, where it powered correction patches,
 * streaming-STT self-revisions, and undo restores; it lives here so every
 * aiui surface diffs (and therefore flashes) text the same way.
 *
 * Pure string → runs; no DOM. The presentation half is ./flash.ts.
 */

export interface DiffRun {
  kind: "same" | "del" | "add";
  text: string;
}

/** Word-level diff (LCS) of two strings, merged into runs for rendering. */
export function wordDiff(before: string, after: string): DiffRun[] {
  const a = before.split(/\s+/).filter(Boolean);
  const b = after.split(/\s+/).filter(Boolean);
  // LCS table (these are interaction-sized strings; O(n·m) is nothing).
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const runs: DiffRun[] = [];
  const push = (kind: DiffRun["kind"], word: string) => {
    const last = runs.at(-1);
    if (last?.kind === kind) {
      last.text += ` ${word}`;
    } else {
      runs.push({ kind, text: word });
    }
  };
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      push("same", a[i]);
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      push("del", a[i]);
      i++;
    } else {
      push("add", b[j]);
      j++;
    }
  }
  for (; i < a.length; i++) {
    push("del", a[i]);
  }
  for (; j < b.length; j++) {
    push("add", b[j]);
  }
  return runs;
}
