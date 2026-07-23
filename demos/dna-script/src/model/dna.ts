/**
 * dna.ts — the sequence algebra (playbook layer 1: pure, realm-free, and
 * exhaustively tested). No framework, no time, no DOM: just bases,
 * complementarity, and the predicates this notation exists to make *visible*.
 *
 * The glyph geometry lives next door in glyph.ts; this module knows nothing
 * about how a base is drawn.
 */

/** The four DNA bases. RNA (U) is deliberately out of scope for now. */
export type Base = "A" | "T" | "G" | "C";

/** The bases in the canonical order used by the key/legend. */
export const BASES = ["A", "T", "G", "C"] as const satisfies readonly Base[];

/** The two Watson–Crick pairs. A base belongs to exactly one. */
export type PairKind = "AT" | "GC";

const COMPLEMENT = { A: "T", T: "A", G: "C", C: "G" } as const satisfies Record<Base, Base>;

/** Watson–Crick partner of a base. An involution: `complement(complement(b)) === b`. */
export function complement(base: Base): Base {
  return COMPLEMENT[base];
}

/** Which of the two pairs a base belongs to — the pair a glyph's fill colour encodes. */
export function pairKind(base: Base): PairKind {
  return base === "A" || base === "T" ? "AT" : "GC";
}

/**
 * The reverse complement: the partner strand, read 5'→3' like the original.
 * *Complementing* is what makes the strands pair; *reversing* is what makes
 * them antiparallel — and it is the reversal that turns "read the other strand"
 * into "rotate the page 180°", which is the whole premise of the notation.
 */
export function reverseComplement(seq: readonly Base[]): Base[] {
  const out: Base[] = new Array(seq.length);
  for (let i = 0; i < seq.length; i++) out[i] = COMPLEMENT[seq[seq.length - 1 - i]];
  return out;
}

/**
 * A reverse palindrome (the biologist's "palindrome"): a duplex that reads the
 * same on both strands, `seq === reverseComplement(seq)`. These are the
 * restriction sites and the stems that let a single strand fold back on itself.
 * Only even-length sequences can qualify — an odd centre base would have to be
 * its own complement, and none is.
 */
export function isReversePalindrome(seq: readonly Base[]): boolean {
  if (seq.length === 0 || seq.length % 2 !== 0) return false;
  for (let i = 0; i < seq.length; i++) {
    if (seq[i] !== COMPLEMENT[seq[seq.length - 1 - i]]) return false;
  }
  return true;
}

/**
 * How long a prefix of `seq` pairs with the matching suffix — the stem length
 * of the hairpin this sequence would fold into. A full palindrome returns
 * `seq.length / 2`; the remainder is the unpaired loop.
 */
export function stemLength(seq: readonly Base[]): number {
  const limit = Math.floor(seq.length / 2);
  let n = 0;
  while (n < limit && seq[n] === COMPLEMENT[seq[seq.length - 1 - n]]) n++;
  return n;
}

/** Fraction of bases that are G or C — the pairs the notation draws as a solid centre. */
export function gcFraction(seq: readonly Base[]): number {
  if (seq.length === 0) return 0;
  let gc = 0;
  for (const b of seq) if (b === "G" || b === "C") gc++;
  return gc / seq.length;
}

/** The outcome of reading user text as a sequence. */
export interface ParsedSequence {
  /** The bases that were recognised, in order. */
  bases: Base[];
  /** Distinct characters that were ignored, in first-seen order. */
  rejected: string[];
}

const IS_BASE = /^[ACGT]$/;

/**
 * Read free text as a sequence: case-insensitive, whitespace and punctuation
 * skipped silently, anything else reported so the UI can say what it dropped
 * rather than lying about the input.
 */
export function parseSequence(text: string): ParsedSequence {
  const bases: Base[] = [];
  const rejected: string[] = [];
  for (const raw of text) {
    const ch = raw.toUpperCase();
    if (IS_BASE.test(ch)) {
      bases.push(ch as Base);
    } else if (!/\s|[-_.,;:]/.test(raw) && !rejected.includes(raw)) {
      rejected.push(raw);
    }
  }
  return { bases, rejected };
}

/** Render a sequence back to plain letters — for labels, copy-paste, and tests. */
export function formatSequence(seq: readonly Base[]): string {
  return seq.join("");
}
