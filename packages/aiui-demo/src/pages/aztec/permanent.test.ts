import { describe, expect, it } from "vitest";
import { biadjacency, ryserPermanent, tilingCount } from "./permanent";

describe("ryserPermanent", () => {
  it("matches worked 2×2 and 3×3 examples", () => {
    expect(
      ryserPermanent([
        [1, 1],
        [1, 1],
      ]),
    ).toBe(2);
    expect(
      ryserPermanent([
        [1, 0],
        [0, 1],
      ]),
    ).toBe(1);
    // perm of all-ones m×m is m!
    expect(
      ryserPermanent([
        [1, 1, 1],
        [1, 1, 1],
        [1, 1, 1],
      ]),
    ).toBe(6);
    expect(
      ryserPermanent([
        [1, 2, 3],
        [4, 5, 6],
        [7, 8, 9],
      ]),
    ).toBe(450);
  });
});

describe("biadjacency of AD(n) is balanced and square", () => {
  it("has side n(n+1)", () => {
    for (let n = 1; n <= 4; n++) {
      const M = biadjacency(n);
      expect(M.length).toBe(n * (n + 1));
      expect(M[0].length).toBe(n * (n + 1));
    }
  });
});

describe("permanent counts tilings and equals the EKLP formula", () => {
  it("AD(1)=2, AD(2)=8, AD(3)=64", () => {
    expect(ryserPermanent(biadjacency(1))).toBe(2);
    expect(ryserPermanent(biadjacency(2))).toBe(8);
    expect(ryserPermanent(biadjacency(3))).toBe(64);
  });

  it("permanent === 2^(n(n+1)/2) through n=4", () => {
    for (let n = 1; n <= 4; n++) {
      expect(ryserPermanent(biadjacency(n))).toBe(tilingCount(n));
    }
    expect(tilingCount(4)).toBe(1024);
  });
});
