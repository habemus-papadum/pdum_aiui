/**
 * permanent.ts — counting tilings the hard way, to check the easy way.
 *
 * A domino tiling of AD(n) is a perfect matching of its dual graph: put a
 * vertex on every unit cell and an edge between edge-adjacent cells. That graph
 * is bipartite (2-color the cells like a checkerboard), so its perfect matchings
 * are counted by the *permanent* of the black×white biadjacency matrix. The
 * permanent is #P-hard in general (Valiant 1979) — no known polynomial
 * algorithm — yet EKLP proved this particular count is exactly 2^(n(n+1)/2).
 * We compute the permanent bare-handed with Ryser's inclusion–exclusion formula
 * (O(2^m · m); the matrix is m = n(n+1) on a side) for small n and confirm the
 * two agree.
 *
 * (Kasteleyn's escape hatch: for *planar* graphs the sign problem that makes the
 * permanent hard can be gauged away, and the number of dimer coverings equals
 * the Pfaffian of a Kasteleyn-oriented adjacency matrix — a determinant, in
 * polynomial time. That is why statistical physicists could count dimers on a
 * lattice at all.)
 */

import { inDiamond } from "./shuffle";

/** Black×white biadjacency matrix of the dual graph of AD(n). */
export function biadjacency(n: number): number[][] {
  const size = 2 * n;
  const blackIndex = new Map<number, number>();
  const whiteIndex = new Map<number, number>();
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (!inDiamond(r, c, n)) continue;
      const idx = (r + c) % 2 === 0 ? blackIndex : whiteIndex;
      idx.set(r * size + c, idx.size);
    }
  }
  if (blackIndex.size !== whiteIndex.size) {
    throw new Error(`AD(${n}) is not balanced: ${blackIndex.size} vs ${whiteIndex.size}`);
  }
  const m = blackIndex.size;
  const M = Array.from({ length: m }, () => new Array<number>(m).fill(0));
  const neighbors = [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
  ];
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if ((r + c) % 2 !== 0 || !inDiamond(r, c, n)) continue;
      const bi = blackIndex.get(r * size + c);
      if (bi === undefined) continue;
      for (const [dr, dc] of neighbors) {
        const wi = whiteIndex.get((r + dr) * size + (c + dc));
        if (wi !== undefined) M[bi][wi] = 1;
      }
    }
  }
  return M;
}

const popcount = (x: number): number => {
  let v = x - ((x >> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >> 2) & 0x33333333);
  return (((v + (v >> 4)) & 0x0f0f0f0f) * 0x01010101) >> 24;
};

/**
 * Ryser's formula with a Gray-code walk over column subsets, maintaining each
 * row's running sum so every subset costs O(m). Exact for the counts we use
 * (≤ 2^10, comfortably inside a double).
 */
export function ryserPermanent(A: number[][]): number {
  const m = A.length;
  if (m === 0) return 1;
  const rowSum = new Float64Array(m);
  let perm = 0;
  let prevGray = 0;
  const upper = 1 << m;
  for (let k = 1; k < upper; k++) {
    const gray = k ^ (k >> 1);
    const diff = gray ^ prevGray; // exactly one bit
    const j = 31 - Math.clz32(diff);
    const added = (gray & diff) !== 0;
    for (let i = 0; i < m; i++) rowSum[i] += added ? A[i][j] : -A[i][j];
    let prod = 1;
    for (let i = 0; i < m; i++) prod *= rowSum[i];
    // Ryser sign: (-1)^(m - |subset|).
    perm += ((m - popcount(gray)) & 1 ? -1 : 1) * prod;
    prevGray = gray;
  }
  return Math.round(perm);
}

/** EKLP's closed form: AD(n) has exactly 2^(n(n+1)/2) tilings. */
export function tilingCount(n: number): number {
  return 2 ** ((n * (n + 1)) / 2);
}
