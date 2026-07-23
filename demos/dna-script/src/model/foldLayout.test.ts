import { describe, expect, it } from "vitest";
import { type Base, parseSequence } from "./dna";
import { foldSequence, parseDotBracket } from "./fold";
import { type FoldLayout, layoutFold, loopRadius, overlappingPairs } from "./foldLayout";
import { DEFAULT_METRICS } from "./glyph";

const M = DEFAULT_METRICS;
const seq = (s: string) => parseSequence(s).bases;

function layoutOf(text: string, structure?: string): FoldLayout {
  const bases = seq(text);
  const pairs = structure ? parseDotBracket(structure) : foldSequence(bases);
  return layoutFold(bases, pairs, M);
}

const at = (l: FoldLayout, i: number) => {
  const b = l.bases.find((x) => x.index === i);
  if (!b) throw new Error(`base ${i} was not placed`);
  return b;
};

const dist = (a: { cx: number; cy: number }, b: { cx: number; cy: number }) =>
  Math.hypot(a.cx - b.cx, a.cy - b.cy);

describe("loopRadius", () => {
  it("closes the circle exactly", () => {
    for (const [nH, nW] of [
      [1, 6],
      [2, 9],
      [3, 12],
      [1, 3],
    ]) {
      const r = loopRadius(nH, nW, M.height, M.width);
      const total = nH * 2 * Math.asin(M.height / (2 * r)) + nW * 2 * Math.asin(M.width / (2 * r));
      expect(total).toBeCloseTo(2 * Math.PI, 6);
    }
  });

  it("grows with the number of bases on the loop", () => {
    const small = loopRadius(1, 4, M.height, M.width);
    const big = loopRadius(1, 20, M.height, M.width);
    expect(big).toBeGreaterThan(small);
  });

  it("never returns a radius that cannot hold its own chords", () => {
    const r = loopRadius(1, 1, M.height, M.width);
    expect(r).toBeGreaterThanOrEqual(Math.max(M.height, M.width) / 2);
  });
});

describe("layoutFold", () => {
  it("places every base exactly once", () => {
    const l = layoutOf("GCGCAAAAGCGC");
    expect(l.bases).toHaveLength(12);
    expect(new Set(l.bases.map((b) => b.index)).size).toBe(12);
  });

  it("puts paired bases exactly one cell-height apart — so the teeth meet", () => {
    const l = layoutOf("GCGCAAAAGCGC");
    for (const b of l.bases) {
      if (b.partner < 0) continue;
      expect(dist(b, at(l, b.partner))).toBeCloseTo(M.height, 6);
    }
  });

  it("turns the 3' half of every pair and not the 5' half", () => {
    const l = layoutOf("GCGCAAAAGCGC");
    for (const b of l.bases) {
      if (b.partner < 0) {
        expect(b.turned).toBe(false);
        continue;
      }
      expect(b.turned).toBe(b.index > b.partner);
    }
  });

  it("gives both halves of a pair the same cell rotation", () => {
    const l = layoutOf("GCGCAAAAGCGC");
    for (const b of l.bases) {
      if (b.partner < 0) continue;
      expect(b.angle).toBeCloseTo(at(l, b.partner).angle, 6);
    }
  });

  it("stacks a helix along a straight axis at one cell-width per step", () => {
    const l = layoutOf("GCGCAAAAGCGC");
    // Pairs (0,11), (1,10), (2,9), (3,8) form one helix.
    for (let t = 0; t < 3; t++) {
      expect(dist(at(l, t), at(l, t + 1))).toBeCloseTo(M.width, 6);
      expect(at(l, t).angle).toBeCloseTo(at(l, t + 1).angle, 6);
    }
  });

  it("never crowds loop bases closer than a backbone step", () => {
    // 4..7 are the AAAA loop. A small loop is opened past the chord solution
    // (MIN_LOOP_RADIUS) so the cells standing on it do not converge — so the
    // guarantee is a floor, not an equality.
    const l = layoutOf("GCGCAAAAGCGC");
    for (let i = 4; i < 7; i++) {
      expect(dist(at(l, i), at(l, i + 1))).toBeGreaterThanOrEqual(M.width - 1e-6);
    }
  });

  it("keeps every loop's cells clear of the loop centre", () => {
    // The failure this pins: a four-base loop solves to a radius smaller than
    // the cells are tall, and they pile up on top of each other.
    for (const s of ["GCGCAAAAGCGC", "GGGGATTTCCCC", "GCGCAAAAAAAAGCGC"]) {
      const l = layoutOf(s);
      expect(overlappingPairs(l, M.width * 0.7), s).toEqual([]);
    }
  });

  it("bulges the loop away from its helix rather than back over it", () => {
    const l = layoutOf("GCGCAAAAGCGC");
    // The helix runs up the page (-y) from the baseline, so the hairpin loop
    // must sit further up than the pair that closes it.
    const closing = at(l, 3);
    for (let i = 4; i <= 7; i++) expect(at(l, i).cy).toBeLessThan(closing.cy);
  });

  it("lays an unpaired strand along the baseline", () => {
    const l = layoutOf("AAAAAAAA");
    for (const b of l.bases) {
      expect(b.cy).toBe(0);
      expect(b.angle).toBe(0);
      expect(b.turned).toBe(false);
    }
    for (let i = 0; i < 7; i++) expect(dist(at(l, i), at(l, i + 1))).toBeCloseTo(M.width, 6);
  });

  it("keeps a plain hairpin free of collisions", () => {
    const l = layoutOf("GCGCAAAAGCGC");
    expect(overlappingPairs(l, M.width * 0.7)).toEqual([]);
  });

  it("handles a bulge without losing a base", () => {
    // (0,12) (1,11) · bulge at 2 · (3,10) (4,9) · AAAA loop.
    const structure = "((.((....))))";
    const l = layoutOf("GCAGCAAAAGCGC", structure);
    expect(l.bases).toHaveLength(structure.length);
    for (const b of l.bases) {
      if (b.partner < 0) continue;
      expect(dist(b, at(l, b.partner))).toBeCloseTo(M.height, 6);
    }
  });

  it("handles a multiloop — two hairpins off one junction", () => {
    const text = "GCGCAAAAGCGCTTTTGCGCAAAAGCGC";
    const l = layoutOf(text);
    expect(l.bases).toHaveLength(text.length);
    for (const b of l.bases) {
      if (b.partner < 0) continue;
      expect(dist(b, at(l, b.partner))).toBeCloseTo(M.height, 6);
    }
  });

  it("reports bounds that contain every placed cell", () => {
    const l = layoutOf("GCGCAAAAGCGC");
    for (const b of l.bases) {
      expect(b.cx).toBeGreaterThanOrEqual(l.minX);
      expect(b.cx).toBeLessThanOrEqual(l.maxX);
      expect(b.cy).toBeGreaterThanOrEqual(l.minY);
      expect(b.cy).toBeLessThanOrEqual(l.maxY);
    }
    expect(l.maxX).toBeGreaterThan(l.minX);
  });

  it("survives the empty strand", () => {
    const l = layoutFold([] as Base[], new Int32Array(0), M);
    expect(l.bases).toEqual([]);
  });

  it("places every base for many random strands, pairs always meeting", () => {
    let state = 987654;
    const rnd = () => {
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      return state / 0x7fffffff;
    };
    const alphabet: Base[] = ["A", "T", "G", "C"];
    for (let trial = 0; trial < 40; trial++) {
      const len = 10 + Math.floor(rnd() * 30);
      const bases: Base[] = [];
      for (let k = 0; k < len; k++) bases.push(alphabet[Math.floor(rnd() * 4)]);
      const l = layoutFold(bases, foldSequence(bases), M);
      expect(l.bases, `strand ${bases.join("")}`).toHaveLength(len);
      for (const b of l.bases) {
        expect(Number.isFinite(b.cx) && Number.isFinite(b.cy)).toBe(true);
        if (b.partner >= 0) {
          expect(dist(b, at(l, b.partner))).toBeCloseTo(M.height, 4);
        }
      }
    }
  });
});
