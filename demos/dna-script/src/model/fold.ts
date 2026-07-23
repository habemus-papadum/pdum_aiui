/**
 * fold.ts — secondary structure (playbook layer 1: pure, realm-free, tested).
 *
 * A duplex needs two strands. A *fold* needs only one: a strand can pair with
 * itself wherever some stretch meets a later stretch that is its reverse
 * complement. The whole fragment need not be a palindrome — only the two arms
 * have to match, and whatever sits between them is left over as a loop.
 *
 * ## What "which bases pair" means here
 *
 * Finding the pairing is a search, not a reading: a fragment usually admits
 * many consistent foldings and you want the best one. This module runs
 * **Nussinov** maximum-pairing (O(n³) time, O(n²) space) with G·C worth more
 * than A·T, then discards helices shorter than `minHelix` because a lone
 * isolated pair is an artefact of maximising a count.
 *
 * **This is a toy folder, not a thermodynamic one.** Real structure prediction
 * minimises free energy with stacking and loop-entropy parameters (Turner);
 * maximum-pairing has no such notion, so it will happily propose a structure
 * that no real molecule would adopt. It is here because it makes the *notation*
 * work on arbitrary input — not because it predicts biology.
 *
 * Pairing is Watson–Crick only (no G·U wobble). That is right for DNA, and it
 * is also what keeps the notation honest: only complements mesh, so every pair
 * this module reports is one the glyphs can actually draw interlocked.
 */
import { type Base, complement } from "./dna";

/**
 * A pairing table: `pairs[i]` is the index `i` pairs with, or `-1` if unpaired.
 * Always symmetric (`pairs[pairs[i]] === i`) and always nested — no pseudoknots,
 * which is what makes the structure a tree and therefore drawable.
 */
export type PairTable = Int32Array;

/** Watson–Crick only: a base pairs with its complement and nothing else. */
export function canPair(a: Base, b: Base): boolean {
  return complement(a) === b;
}

/** G·C is worth more than A·T — three hydrogen bonds against two. */
export function pairScore(a: Base, b: Base): number {
  if (!canPair(a, b)) return 0;
  return a === "G" || a === "C" ? 3 : 2;
}

export interface FoldOptions {
  /** Fewest unpaired bases a hairpin loop may contain. Steric floor: 3. */
  minLoop?: number;
  /** Helices shorter than this are discarded after the search. */
  minHelix?: number;
}

/**
 * Fold a strand onto itself, returning the pairing table.
 *
 * @see the module docblock — this maximises weighted pair count, it does not
 * minimise free energy.
 */
export function foldSequence(seq: readonly Base[], opts: FoldOptions = {}): PairTable {
  const minLoop = opts.minLoop ?? 3;
  const minHelix = opts.minHelix ?? 2;
  const n = seq.length;
  const pairs = new Int32Array(n).fill(-1);
  if (n === 0) return pairs;

  // best[i*n + j] — the best score attainable within the window [i, j].
  const best = new Int32Array(n * n);
  const at = (i: number, j: number) => (i > j || i < 0 || j >= n ? 0 : best[i * n + j]);

  for (let span = minLoop + 2; span <= n; span++) {
    for (let i = 0; i + span - 1 < n; i++) {
      const j = i + span - 1;
      let v = at(i + 1, j);
      const skipJ = at(i, j - 1);
      if (skipJ > v) v = skipJ;
      if (j - i - 1 >= minLoop && canPair(seq[i], seq[j])) {
        const closed = at(i + 1, j - 1) + pairScore(seq[i], seq[j]);
        if (closed > v) v = closed;
      }
      for (let k = i + 1; k < j; k++) {
        const split = at(i, k) + at(k + 1, j);
        if (split > v) v = split;
      }
      best[i * n + j] = v;
    }
  }

  // Traceback. Scores are integers, so these equality tests are exact.
  const stack: Array<[number, number]> = [[0, n - 1]];
  while (stack.length > 0) {
    const frame = stack.pop();
    if (!frame) break;
    const [i, j] = frame;
    if (i >= j) continue;
    const v = at(i, j);
    if (v === at(i + 1, j)) {
      stack.push([i + 1, j]);
      continue;
    }
    if (v === at(i, j - 1)) {
      stack.push([i, j - 1]);
      continue;
    }
    if (
      j - i - 1 >= minLoop &&
      canPair(seq[i], seq[j]) &&
      v === at(i + 1, j - 1) + pairScore(seq[i], seq[j])
    ) {
      pairs[i] = j;
      pairs[j] = i;
      stack.push([i + 1, j - 1]);
      continue;
    }
    for (let k = i + 1; k < j; k++) {
      if (v === at(i, k) + at(k + 1, j)) {
        stack.push([i, k]);
        stack.push([k + 1, j]);
        break;
      }
    }
  }

  if (minHelix > 1) pruneShortHelices(pairs, minHelix);
  return pairs;
}

/**
 * Drop helices shorter than `minHelix`. Maximising a pair count rewards lone
 * pairs that stack on nothing; removing them leaves a valid (still nested)
 * structure that reads as actual helices.
 */
export function pruneShortHelices(pairs: PairTable, minHelix: number): void {
  for (const h of helices(pairs)) {
    if (h.length >= minHelix) continue;
    for (let t = 0; t < h.length; t++) {
      pairs[h.i + t] = -1;
      pairs[h.j - t] = -1;
    }
  }
}

/** One maximal run of stacked pairs: (i,j), (i+1,j-1), … `length` of them. */
export interface Helix {
  i: number;
  j: number;
  length: number;
}

/** Every maximal stacked run in the table, outermost pair first. */
export function helices(pairs: PairTable): Helix[] {
  const n = pairs.length;
  const out: Helix[] = [];
  for (let i = 0; i < n; i++) {
    const j = pairs[i];
    if (j <= i) continue;
    // Only start at the outermost pair of a run.
    if (i > 0 && pairs[i - 1] === j + 1) continue;
    let length = 0;
    let a = i;
    let b = j;
    while (a < b && pairs[a] === b) {
      length++;
      a++;
      b--;
    }
    out.push({ i, j, length });
  }
  return out;
}

/** How long the helix starting at pair (i, j) runs. Zero if (i,j) is not a pair. */
export function helixLength(pairs: PairTable, i: number, j: number): number {
  let length = 0;
  let a = i;
  let b = j;
  while (a < b && pairs[a] === b) {
    length++;
    a++;
    b--;
  }
  return length;
}

/** The kinds of loop a nested structure can contain. */
export type LoopKind = "exterior" | "hairpin" | "stack" | "bulge" | "internal" | "multi";

export interface Loop {
  kind: LoopKind;
  /** The pair enclosing this loop, or null for the exterior. */
  closing: readonly [number, number] | null;
  /** Unpaired bases belonging to this loop, 5'→3'. */
  unpaired: number[];
  /** Pairs opening a helix directly out of this loop, 5'→3'. */
  children: Array<readonly [number, number]>;
}

/**
 * Walk the interior of `(i, j)` — or the whole strand when `closing` is null —
 * collecting the bases that belong to this loop and the helices leaving it.
 * Bases inside a child helix belong to that child's loops, not this one.
 */
export function loopContents(
  pairs: PairTable,
  closing: readonly [number, number] | null,
): Pick<Loop, "unpaired" | "children"> {
  const n = pairs.length;
  const from = closing ? closing[0] + 1 : 0;
  const to = closing ? closing[1] - 1 : n - 1;
  const unpaired: number[] = [];
  const children: Array<readonly [number, number]> = [];
  for (let k = from; k <= to; k++) {
    const p = pairs[k];
    if (p > k) {
      children.push([k, p]);
      k = p;
    } else if (p === -1) {
      unpaired.push(k);
    }
  }
  return { unpaired, children };
}

/** Name a loop from its shape. */
export function classifyLoop(
  closing: readonly [number, number] | null,
  unpaired: number[],
  children: Array<readonly [number, number]>,
): LoopKind {
  if (!closing) return "exterior";
  if (children.length === 0) return "hairpin";
  if (children.length > 1) return "multi";
  if (unpaired.length === 0) return "stack";
  const [k, l] = children[0];
  const before = unpaired.filter((u) => u < k).length;
  const after = unpaired.filter((u) => u > l).length;
  return before === 0 || after === 0 ? "bulge" : "internal";
}

/** Every loop in the structure, exterior first, then in 5'→3' order of closing pair. */
export function loops(pairs: PairTable): Loop[] {
  const out: Loop[] = [];
  const visit = (closing: readonly [number, number] | null) => {
    const { unpaired, children } = loopContents(pairs, closing);
    out.push({ kind: classifyLoop(closing, unpaired, children), closing, unpaired, children });
    for (const child of children) {
      // Descend past the stacked run: each pair in a helix closes its own
      // (stack) loop, and those are real loops we want listed.
      visit(child);
    }
  };
  visit(null);
  return out;
}

/** Dot-bracket notation — the conventional one-line spelling of a structure. */
export function dotBracket(pairs: PairTable): string {
  let s = "";
  for (let i = 0; i < pairs.length; i++) {
    s += pairs[i] === -1 ? "." : pairs[i] > i ? "(" : ")";
  }
  return s;
}

/** Read dot-bracket back into a pair table — for tests and hand-written structures. */
export function parseDotBracket(text: string): PairTable {
  const pairs = new Int32Array(text.length).fill(-1);
  const stack: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "(") stack.push(i);
    else if (c === ")") {
      const j = stack.pop();
      if (j === undefined) throw new Error(`unbalanced ) at ${i}`);
      pairs[i] = j;
      pairs[j] = i;
    }
  }
  if (stack.length > 0) throw new Error(`unbalanced ( at ${stack[stack.length - 1]}`);
  return pairs;
}

/** How many bases are paired. */
export function pairedCount(pairs: PairTable): number {
  let n = 0;
  for (let i = 0; i < pairs.length; i++) if (pairs[i] !== -1) n++;
  return n;
}
