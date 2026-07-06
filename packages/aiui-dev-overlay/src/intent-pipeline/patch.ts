/**
 * The correction micro-pipeline's diff machinery.
 *
 * Corrections are LLM-generated **patches**, not string replacements: the
 * model sees the whole transcript (one segment per line), the selected span,
 * and the spoken/typed instruction, and answers in OpenAI's `apply_patch`
 * (V4A) format — the patch grammar their models are trained to emit, applied
 * by matching *context*, never line numbers (see the OpenAI Apply Patch guide
 * and the reference appliers in the Agents SDKs). We implement the
 * single-document subset: one `*** Update File:` section, `@@` hunks with
 * ` `/`-`/`+` lines.
 *
 * `wordDiff` is the presentation half: a word-level LCS between before/after
 * used to flash the pink/green inline view for a beat before settling on the
 * clean text.
 */

/** One parsed hunk: consecutive context/del/add lines. */
interface Hunk {
  /** The lines this hunk must match in the document (context + deletions). */
  match: string[];
  /** What those lines become (context + additions). */
  replace: string[];
}

/**
 * Apply a V4A-subset patch to a document given as lines. Returns the new
 * lines, or throws with a reason (bad grammar, context not found) — callers
 * treat a throw as "the model's patch didn't apply" and keep the original.
 */
export function applyPatch(lines: string[], patch: string): string[] {
  const hunks = parsePatch(patch);
  let result = [...lines];
  for (const hunk of hunks) {
    const at = findHunk(result, hunk.match);
    if (at === -1) {
      throw new Error(`patch context not found: ${JSON.stringify(hunk.match.join("\\n"))}`);
    }
    result = [...result.slice(0, at), ...hunk.replace, ...result.slice(at + hunk.match.length)];
  }
  return result;
}

function parsePatch(patch: string): Hunk[] {
  const lines = patch.replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((l) => l.trim() === "*** Begin Patch");
  const end = lines.findIndex((l) => l.trim() === "*** End Patch");
  if (start === -1 || end === -1 || end < start) {
    throw new Error("not a V4A patch (missing Begin/End Patch markers)");
  }
  const body = lines.slice(start + 1, end).filter((l) => !l.startsWith("*** "));

  const hunks: Hunk[] = [];
  let current: Hunk | undefined;
  const flush = () => {
    if (current && (current.match.length || current.replace.length)) {
      hunks.push(current);
    }
    current = undefined;
  };
  for (const line of body) {
    if (line.startsWith("@@")) {
      flush();
      current = { match: [], replace: [] };
      continue;
    }
    current ??= { match: [], replace: [] };
    if (line.startsWith("-")) {
      current.match.push(line.slice(1));
    } else if (line.startsWith("+")) {
      current.replace.push(line.slice(1));
    } else {
      // Context: a leading space per the grammar, but be lenient about its absence.
      const text = line.startsWith(" ") ? line.slice(1) : line;
      current.match.push(text);
      current.replace.push(text);
    }
  }
  flush();
  if (!hunks.length) {
    throw new Error("patch has no hunks");
  }
  return hunks;
}

/** Context-anchored hunk location: exact match first, then whitespace-trimmed. */
function findHunk(doc: string[], match: string[]): number {
  if (!match.length) {
    return -1;
  }
  const fits = (i: number, eq: (a: string, b: string) => boolean) =>
    match.every((m, j) => i + j < doc.length && eq(doc[i + j], m));
  for (let i = 0; i + match.length <= doc.length; i++) {
    if (fits(i, (a, b) => a === b)) {
      return i;
    }
  }
  for (let i = 0; i + match.length <= doc.length; i++) {
    if (fits(i, (a, b) => a.trim() === b.trim())) {
      return i;
    }
  }
  return -1;
}

/**
 * Apply one correction to the transcript lines: the patch when the pipeline
 * produced one (and it applies), else the plain first-occurrence replacement
 * fallback. Never throws — a correction that can't land leaves the lines
 * untouched, which the UI surfaces as "not applied".
 */
export function applyCorrectionToLines(
  lines: string[],
  correction: { patch?: string; original: string; instruction: string },
): { lines: string[]; applied: boolean } {
  if (correction.patch) {
    try {
      return { lines: applyPatch(lines, correction.patch), applied: true };
    } catch {
      // fall through to the plain replacement
    }
  }
  // A whole-transcript correction (empty original — no marked span) has no
  // meaningful plain replacement: `includes("")` matches every line and would
  // splice the instruction into the text. Patch or nothing.
  if (correction.original === "") {
    return { lines, applied: false };
  }
  const at = lines.findIndex((line) => line.includes(correction.original));
  if (at === -1) {
    return { lines, applied: false };
  }
  const next = [...lines];
  next[at] = next[at].replace(correction.original, correction.instruction);
  return { lines: next, applied: true };
}

// ── the pretty half ──────────────────────────────────────────────────────────

export interface DiffRun {
  kind: "same" | "del" | "add";
  text: string;
}

/** Word-level diff (LCS) of two strings, merged into runs for rendering. */
export function wordDiff(before: string, after: string): DiffRun[] {
  const a = before.split(/\s+/).filter(Boolean);
  const b = after.split(/\s+/).filter(Boolean);
  // LCS table (transcripts are short; O(n·m) is nothing).
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
