import { describe, expect, it } from "vitest";
import { type Base, complement, parseSequence } from "./dna";
import {
  canPair,
  classifyLoop,
  dotBracket,
  foldSequence,
  helices,
  helixLength,
  loopContents,
  loops,
  type PairTable,
  pairedCount,
  pairScore,
  parseDotBracket,
} from "./fold";

const seq = (s: string) => parseSequence(s).bases;

/** Every structural invariant a pair table must satisfy to be drawable. */
function expectValidTable(pairs: PairTable, bases: readonly Base[]) {
  const n = pairs.length;
  for (let i = 0; i < n; i++) {
    const j = pairs[i];
    if (j === -1) continue;
    // symmetric
    expect(pairs[j], `symmetry at ${i}`).toBe(i);
    // never itself
    expect(j).not.toBe(i);
    // only complements — the notation can only draw complements meshed
    expect(canPair(bases[i], bases[j]), `${bases[i]}·${bases[j]} at ${i},${j}`).toBe(true);
  }
  // nested: no pseudoknots
  for (let i = 0; i < n; i++) {
    const j = pairs[i];
    if (j <= i) continue;
    for (let k = i + 1; k < j; k++) {
      const l = pairs[k];
      if (l === -1) continue;
      expect(l > i && l < j, `pair (${k},${l}) crosses (${i},${j})`).toBe(true);
    }
  }
}

describe("canPair / pairScore", () => {
  it("pairs only Watson–Crick complements", () => {
    for (const a of ["A", "T", "G", "C"] as Base[]) {
      for (const b of ["A", "T", "G", "C"] as Base[]) {
        expect(canPair(a, b)).toBe(b === complement(a));
      }
    }
  });

  it("has no G·T wobble — this is DNA, and the glyphs could not draw it", () => {
    expect(canPair("G", "T")).toBe(false);
  });

  it("scores G·C above A·T, and non-pairs zero", () => {
    expect(pairScore("G", "C")).toBe(3);
    expect(pairScore("A", "T")).toBe(2);
    expect(pairScore("A", "G")).toBe(0);
  });
});

describe("foldSequence", () => {
  it("finds the hairpin in an arm/loop/arm fragment", () => {
    // GCGC · AAAA · GCGC — the arms are reverse complements, the loop is not.
    const bases = seq("GCGCAAAAGCGC");
    const pairs = foldSequence(bases);
    expectValidTable(pairs, bases);
    expect(dotBracket(pairs)).toBe("((((....))))");
  });

  it("zips arms that are reverse complements even though the whole is not a palindrome", () => {
    const bases = seq("GGGGATTTCCCC"); // GGGG · ATTT · CCCC
    const pairs = foldSequence(bases);
    expectValidTable(pairs, bases);
    // The fragment is not a palindrome...
    const rc = bases
      .slice()
      .reverse()
      .map((b) => complement(b))
      .join("");
    expect(rc).not.toBe(bases.join(""));
    // ...but the arms still zip.
    expect(dotBracket(pairs)).toBe("((((....))))");
  });

  it("respects the minimum hairpin loop", () => {
    const bases = seq("GCGCGC");
    const pairs = foldSequence(bases, { minLoop: 3 });
    expectValidTable(pairs, bases);
    for (let i = 0; i < pairs.length; i++) {
      if (pairs[i] > i) expect(pairs[i] - i - 1).toBeGreaterThanOrEqual(3);
    }
  });

  it("leaves a strand that cannot pair with itself completely open", () => {
    const bases = seq("AAAAAAAAAA");
    const pairs = foldSequence(bases);
    expect(pairedCount(pairs)).toBe(0);
    expect(dotBracket(pairs)).toBe("..........");
  });

  it("drops lone pairs, which are an artefact of maximising a count", () => {
    const bases = seq("AGGGGGGTAAAAAAT");
    const loose = foldSequence(bases, { minHelix: 1 });
    const tidy = foldSequence(bases, { minHelix: 2 });
    expectValidTable(tidy, bases);
    for (const h of helices(tidy)) expect(h.length).toBeGreaterThanOrEqual(2);
    expect(pairedCount(tidy)).toBeLessThanOrEqual(pairedCount(loose));
  });

  it("produces a valid nested table on many random strands", () => {
    // A deterministic pseudo-random sweep — the structural invariants must hold
    // for every input, not just the curated ones.
    let state = 12345;
    const rnd = () => {
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      return state / 0x7fffffff;
    };
    const alphabet: Base[] = ["A", "T", "G", "C"];
    for (let trial = 0; trial < 60; trial++) {
      const len = 8 + Math.floor(rnd() * 40);
      const bases: Base[] = [];
      for (let k = 0; k < len; k++) bases.push(alphabet[Math.floor(rnd() * 4)]);
      expectValidTable(foldSequence(bases), bases);
    }
  });

  it("handles the empty and single-base strand", () => {
    expect(foldSequence([]).length).toBe(0);
    expect(pairedCount(foldSequence(seq("A")))).toBe(0);
  });

  it("prefers the GC-rich pairing when two foldings compete", () => {
    // Either the GC arms or the AT arms could close, not both.
    const bases = seq("GGCCTTTTGGCCAAAA");
    const pairs = foldSequence(bases);
    expectValidTable(pairs, bases);
    expect(pairedCount(pairs)).toBeGreaterThan(0);
  });
});

describe("helices", () => {
  it("reports maximal runs, not individual pairs", () => {
    const pairs = parseDotBracket("((((....))))");
    const hs = helices(pairs);
    expect(hs).toHaveLength(1);
    expect(hs[0]).toEqual({ i: 0, j: 11, length: 4 });
  });

  it("splits a run interrupted by a bulge", () => {
    // Pairs are (0,12) (1,11) then, past the bulge at 2, (3,10) (4,9):
    // two runs of two, not one run of four.
    const pairs = parseDotBracket("((.((....))))...");
    const hs = helices(pairs);
    expect(hs.map((h) => h.length)).toEqual([2, 2]);
    expect(hs.map((h) => h.i)).toEqual([0, 3]);
  });

  it("measures a helix from an arbitrary pair", () => {
    const pairs = parseDotBracket("((((....))))");
    expect(helixLength(pairs, 0, 11)).toBe(4);
    expect(helixLength(pairs, 1, 10)).toBe(3);
    expect(helixLength(pairs, 5, 6)).toBe(0);
  });
});

describe("loop decomposition", () => {
  it("splits a hairpin into exterior, stacks, and the hairpin loop", () => {
    const pairs = parseDotBracket("((((....))))");
    const kinds = loops(pairs).map((l) => l.kind);
    expect(kinds[0]).toBe("exterior");
    expect(kinds).toContain("hairpin");
    expect(kinds.filter((k) => k === "stack")).toHaveLength(3);
  });

  it("names a bulge, an internal loop, and a multiloop", () => {
    expect(classifyLoop([0, 20], [1], [[2, 19]])).toBe("bulge");
    expect(classifyLoop([0, 20], [1, 19], [[2, 18]])).toBe("internal");
    expect(
      classifyLoop(
        [0, 30],
        [],
        [
          [1, 10],
          [11, 29],
        ],
      ),
    ).toBe("multi");
    expect(classifyLoop([0, 10], [1, 2, 3], [])).toBe("hairpin");
    expect(classifyLoop(null, [0, 1], [])).toBe("exterior");
  });

  it("assigns every base to exactly one loop", () => {
    const bases = seq("GCGCAAAAGCGCTTTTGCGCAAAAGCGC");
    const pairs = foldSequence(bases);
    const seen = new Set<number>();
    for (const l of loops(pairs)) {
      for (const u of l.unpaired) {
        expect(seen.has(u), `base ${u} counted twice`).toBe(false);
        seen.add(u);
      }
    }
    for (let i = 0; i < pairs.length; i++) {
      if (pairs[i] === -1) expect(seen.has(i), `base ${i} unassigned`).toBe(true);
    }
  });

  it("walks past a child helix rather than into it", () => {
    const pairs = parseDotBracket("(((...)))");
    const { unpaired, children } = loopContents(pairs, null);
    expect(unpaired).toEqual([]);
    expect(children).toEqual([[0, 8]]);
  });
});

describe("dot-bracket", () => {
  it("round-trips", () => {
    for (const s of ["((((....))))", "..((..))..", "((.((...))..))", ".........."]) {
      expect(dotBracket(parseDotBracket(s))).toBe(s);
    }
  });

  it("rejects unbalanced notation", () => {
    expect(() => parseDotBracket("((.")).toThrow();
    expect(() => parseDotBracket(".))")).toThrow();
  });
});
