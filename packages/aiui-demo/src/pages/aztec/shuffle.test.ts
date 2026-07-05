import { describe, expect, it } from "vitest";
import { mulberry32 } from "./rng";
import {
  create,
  destruct,
  frozenFraction,
  generate,
  initTiling,
  rasterize,
  slideGrow,
  step,
  type Tiling,
  tilingProblem,
} from "./shuffle";
import { E, N, S, W } from "./types";

describe("initTiling", () => {
  it("is a single valid 2×2 block of either orientation", () => {
    for (let seed = 0; seed < 20; seed++) {
      const t = initTiling(mulberry32(seed));
      expect(t.n).toBe(1);
      expect(t.dominoes.length).toBe(2);
      expect(tilingProblem(t)).toBeNull();
    }
  });
});

describe("AD(1) → AD(2) trace", () => {
  // A horizontal AD(1) (N over S) has no bad block, slides to the top and
  // bottom of AD(2), leaving the two middle rows to be filled — the hand
  // computation the movement formulas were derived from.
  it("slides the horizontal seed to the diamond's poles", () => {
    const seed: Tiling = {
      n: 1,
      dominoes: [
        { t: N, r: 0, c: 0 },
        { t: S, r: 1, c: 0 },
      ],
    };
    expect(destruct(seed).dominoes.length).toBe(2); // N-over-S is not facing
    const slid = slideGrow(destruct(seed));
    expect(slid.n).toBe(2);
    expect(slid.dominoes).toContainEqual({ t: N, r: 0, c: 1 });
    expect(slid.dominoes).toContainEqual({ t: S, r: 3, c: 1 });
  });

  it("destroys a facing S-over-N block", () => {
    const facing: Tiling = {
      n: 2,
      dominoes: [
        { t: S, r: 1, c: 1 },
        { t: N, r: 2, c: 1 },
      ],
    };
    expect(destruct(facing).dominoes.length).toBe(0);
  });

  it("destroys a facing E-left-of-W block", () => {
    const facing: Tiling = {
      n: 2,
      dominoes: [
        { t: E, r: 1, c: 1 },
        { t: W, r: 1, c: 2 },
      ],
    };
    expect(destruct(facing).dominoes.length).toBe(0);
  });
});

describe("tiling validity is preserved under shuffling", () => {
  it("every order 1..40 is a valid tiling of AD(n)", () => {
    const rng = mulberry32(12345);
    let t = initTiling(rng);
    expect(tilingProblem(t)).toBeNull();
    for (let n = 1; n < 40; n++) {
      t = step(t, rng);
      expect(t.n).toBe(n + 1);
      expect(tilingProblem(t)).toBeNull();
    }
  });

  it("holds across many independent seeds", () => {
    for (let seed = 1; seed <= 25; seed++) {
      const t = generate(16, mulberry32(seed * 7919));
      expect(tilingProblem(t)).toBeNull();
    }
  });
});

describe("domino counts", () => {
  it("AD(n) has exactly n(n+1) dominoes", () => {
    const rng = mulberry32(99);
    let t = initTiling(rng);
    for (let n = 1; n <= 30; n++) {
      expect(t.dominoes.length).toBe(n * (n + 1));
      if (n < 30) t = step(t, rng);
    }
  });
});

describe("determinism", () => {
  it("same seed ⇒ identical tiling; different seed ⇒ (almost always) different", () => {
    const a = rasterize(generate(24, mulberry32(2024)));
    const b = rasterize(generate(24, mulberry32(2024)));
    expect(Array.from(a)).toEqual(Array.from(b));
    const c = rasterize(generate(24, mulberry32(2025)));
    expect(Array.from(a)).not.toEqual(Array.from(c));
  });
});

describe("create rejects an ill-formed empty region", () => {
  it("throws when an in-diamond empty cell is not a block corner", () => {
    // AD(2) with a single vertical domino at (1,1)-(2,1). Scanning row-major,
    // the empty in-diamond cell (1,0) wants a block, but (1,1) is occupied.
    const broken: Tiling = { n: 2, dominoes: [{ t: W, r: 1, c: 1 }] };
    expect(() => create(broken, mulberry32(1))).toThrow(/block corner/);
  });

  it("does not throw filling the vacated region of a valid slide", () => {
    const slid = slideGrow(destruct(initTiling(mulberry32(3))));
    expect(() => create(slid, mulberry32(3))).not.toThrow();
  });
});

describe("frozenFraction", () => {
  it("stays in [0,1] and the corners are frozen at large n", () => {
    const large: number[] = [];
    for (let seed = 1; seed <= 8; seed++) {
      const f6 = frozenFraction(generate(6, mulberry32(seed)));
      const f48 = frozenFraction(generate(48, mulberry32(seed)));
      expect(f6).toBeGreaterThanOrEqual(0);
      expect(f6).toBeLessThanOrEqual(1);
      large.push(f48);
    }
    const mean = large.reduce((s, x) => s + x, 0) / large.length;
    // Outside the arctic circle the four corners have frozen; only a thin
    // boundary band at the circle mismatches, so the fraction is near 1.
    expect(mean).toBeGreaterThan(0.95);
  });

  it("the temperate interior is genuinely mixed — all four types present", () => {
    const t = generate(48, mulberry32(7));
    const counts = { N: 0, S: 0, E: 0, W: 0 };
    for (const d of t.dominoes) {
      if (d.t === N) counts.N++;
      else if (d.t === S) counts.S++;
      else if (d.t === E) counts.E++;
      else counts.W++;
    }
    for (const key of ["N", "S", "E", "W"] as const) {
      expect(counts[key]).toBeGreaterThan(50); // no orientation is frozen out
    }
  });
});
