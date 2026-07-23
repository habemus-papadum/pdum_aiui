import { describe, expect, it } from "vitest";
import {
  BASES,
  type Base,
  complement,
  formatSequence,
  gcFraction,
  isReversePalindrome,
  pairKind,
  parseSequence,
  reverseComplement,
  stemLength,
} from "./dna";

const seq = (s: string) => parseSequence(s).bases;

describe("complement", () => {
  it("is an involution on every base", () => {
    for (const b of BASES) expect(complement(complement(b))).toBe(b);
  });

  it("never fixes a base — which is why odd palindromes cannot exist", () => {
    for (const b of BASES) expect(complement(b)).not.toBe(b);
  });

  it("pairs A with T and G with C", () => {
    expect(complement("A")).toBe("T");
    expect(complement("G")).toBe("C");
  });
});

describe("pairKind", () => {
  it("puts complements in the same pair", () => {
    for (const b of BASES) expect(pairKind(b)).toBe(pairKind(complement(b)));
  });
});

describe("reverseComplement", () => {
  it("is an involution", () => {
    const s = seq("ATGGCTTA");
    expect(formatSequence(reverseComplement(reverseComplement(s)))).toBe(formatSequence(s));
  });

  it("reverses as well as complements", () => {
    expect(formatSequence(reverseComplement(seq("AAAG")))).toBe("CTTT");
  });

  it("puts comp(sᵢ) opposite sᵢ — the invariant the duplex layout relies on", () => {
    const s = seq("ATGCGTAC");
    const rc = reverseComplement(s);
    for (let i = 0; i < s.length; i++) {
      // Position i of the *rotated* partner row is rc[n-1-i].
      expect(rc[s.length - 1 - i]).toBe(complement(s[i]));
    }
  });

  it("returns an empty strand for an empty strand", () => {
    expect(reverseComplement([])).toEqual([]);
  });
});

describe("isReversePalindrome", () => {
  it("accepts real restriction sites", () => {
    for (const site of ["GAATTC", "GGATCC", "AAGCTT", "GTCGAC", "GC", "AT"]) {
      expect(isReversePalindrome(seq(site)), site).toBe(true);
    }
  });

  it("rejects sequences that merely read the same backwards", () => {
    // A plain character palindrome is not a reverse palindrome.
    expect(isReversePalindrome(seq("GATTAG"))).toBe(false);
    expect(isReversePalindrome(seq("ACCA"))).toBe(false);
  });

  it("rejects odd lengths and the empty strand", () => {
    expect(isReversePalindrome(seq("GAATTCA"))).toBe(false);
    expect(isReversePalindrome([])).toBe(false);
  });

  it("agrees with reverseComplement by construction", () => {
    for (const s of ["GAATTC", "ATGC", "AACGTT", "TTTT"]) {
      const bases = seq(s);
      const same = formatSequence(reverseComplement(bases)) === formatSequence(bases);
      expect(isReversePalindrome(bases)).toBe(same);
    }
  });
});

describe("stemLength", () => {
  it("pairs the whole strand for a full palindrome", () => {
    expect(stemLength(seq("GAATTC"))).toBe(3);
  });

  it("stops where the pairing stops, leaving the rest as loop", () => {
    // GC stem, then AAAA which cannot pair with itself.
    expect(stemLength(seq("GCAAAAGC"))).toBe(2);
  });

  it("is zero when the ends do not pair", () => {
    // A cannot pair with A, so nothing zips from the outside in.
    expect(stemLength(seq("AAAAAA"))).toBe(0);
  });

  it("counts every pairing base at the ends, loop or not", () => {
    // AA·TT does pair; only the middle TT fails. A stem of 2, not 0.
    expect(stemLength(seq("AATTTT"))).toBe(2);
  });

  it("never exceeds half the strand", () => {
    for (const s of ["GCGCGCGC", "ATAT", "GGCC"]) {
      expect(stemLength(seq(s))).toBeLessThanOrEqual(Math.floor(s.length / 2));
    }
  });
});

describe("gcFraction", () => {
  it("counts G and C only", () => {
    expect(gcFraction(seq("GGCC"))).toBe(1);
    expect(gcFraction(seq("ATAT"))).toBe(0);
    expect(gcFraction(seq("ATGC"))).toBe(0.5);
  });

  it("is zero for an empty strand rather than NaN", () => {
    expect(gcFraction([])).toBe(0);
  });

  it("is invariant under reverse complement", () => {
    const s = seq("ATGGGCTTA");
    expect(gcFraction(reverseComplement(s))).toBeCloseTo(gcFraction(s), 12);
  });
});

describe("parseSequence", () => {
  it("upper-cases and keeps order", () => {
    expect(formatSequence(parseSequence("atgc").bases)).toBe("ATGC");
  });

  it("skips whitespace and grouping punctuation silently", () => {
    const p = parseSequence("ATG CTA\n-GC.");
    expect(formatSequence(p.bases)).toBe("ATGCTAGC");
    expect(p.rejected).toEqual([]);
  });

  it("reports unknown characters once each, in first-seen order", () => {
    const p = parseSequence("ATGXNXU");
    expect(formatSequence(p.bases)).toBe("ATG");
    expect(p.rejected).toEqual(["X", "N", "U"]);
  });

  it("returns an empty result for empty input", () => {
    const p = parseSequence("");
    expect(p.bases).toEqual([]);
    expect(p.rejected).toEqual([]);
  });
});

describe("formatSequence", () => {
  it("round-trips through parseSequence", () => {
    const text = "GAATTCGGATCC";
    expect(formatSequence(parseSequence(text).bases)).toBe(text);
  });

  it("handles every base", () => {
    expect(formatSequence(BASES as readonly Base[])).toBe("ATGC");
  });
});
