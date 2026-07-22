/**
 * shuffle.ts — EKLP domino shuffling on the Aztec diamond (pure, testable).
 *
 * The Elkies–Kuperberg–Larsen–Propp algorithm grows a uniformly random domino
 * tiling of the Aztec diamond AD(n) one order at a time. AD(n) is the diamond
 * of unit cells whose centers satisfy |x| + |y| ≤ n; it holds 2n(n+1) cells, so
 * a tiling uses n(n+1) dominoes, and there are exactly 2^(n(n+1)/2) of them.
 *
 * We work on a (2n)×(2n) integer grid. A domino carries one of four *types*,
 * which is exactly the direction it moves under a shuffle step:
 *
 *   N  horizontal, moves up     occupies (r,c),(r,c+1)   anchor = left cell
 *   S  horizontal, moves down   occupies (r,c),(r,c+1)
 *   E  vertical,   moves right   occupies (r,c),(r+1,c)   anchor = top cell
 *   W  vertical,   moves left    occupies (r,c),(r+1,c)
 *
 * (Horizontal dominoes move vertically and vertical ones horizontally — the
 * standard, initially-surprising EKLP convention.) One order of growth is three
 * moves, and every move is a local operation on 2×2 blocks:
 *
 *   1. DESTRUCTION — delete every 2×2 block holding two dominoes that face each
 *      other (would collide on the next slide): a horizontal S over an N, or a
 *      vertical E left of a W.
 *   2. SLIDE + GROW — embed the surviving tiling concentrically in the next,
 *      larger diamond (offset +1,+1) and move each domino one cell in its
 *      direction. The two moves compose into a fixed anchor remap (`SLIDE`).
 *   3. CREATION — the vacated cells decompose uniquely into 2×2 blocks; fill
 *      each with a fair coin: heads a horizontal pair (N on top, S below),
 *      tails a vertical pair (W on the left, E on the right). Both pairs point
 *      *out* of their block, the exact opposite of a destroyed block — which is
 *      what makes destruction and creation inverse and the process uniform.
 *
 * Every function here is a pure transform on a plain `Tiling`; the worker
 * (shuffle.worker.ts) is only choreography around them.
 */

import type { Rng } from "./rng";
import { type CellLabel, type Domino, E, EMPTY, N, S, W } from "./types";

export interface Tiling {
  /** Aztec-diamond order. Grid side is 2n. */
  n: number;
  dominoes: Domino[];
}

/** The two cells a domino covers, top-left first. */
export function dominoCells(d: Domino): [number, number][] {
  return d.t === N || d.t === S
    ? [
        [d.r, d.c],
        [d.r, d.c + 1],
      ]
    : [
        [d.r, d.c],
        [d.r + 1, d.c],
      ];
}

/** Is cell (r, c) inside AD(n)? Center of the 2n grid is at (n-0.5, n-0.5). */
export function inDiamond(r: number, c: number, n: number): boolean {
  return Math.abs(c - (n - 0.5)) + Math.abs(r - (n - 0.5)) <= n;
}

/** Cell labels of a tiling as a row-major Int8Array of side 2n. */
export function rasterize(t: Tiling): Int8Array {
  const size = 2 * t.n;
  const grid = new Int8Array(size * size);
  for (const d of t.dominoes) {
    for (const [r, c] of dominoCells(d)) grid[r * size + c] = d.t;
  }
  return grid;
}

/** AD(1): a single 2×2 block, filled by one fair coin. */
export function initTiling(rng: Rng): Tiling {
  const dominoes: Domino[] =
    rng() < 0.5
      ? [
          { t: N, r: 0, c: 0 }, // horizontal pair
          { t: S, r: 1, c: 0 },
        ]
      : [
          { t: W, r: 0, c: 0 }, // vertical pair
          { t: E, r: 0, c: 1 },
        ];
  return { n: 1, dominoes };
}

const key = (r: number, c: number) => r * 1_000_000 + c;

/** Remove every facing (colliding) 2×2 block. */
export function destruct(t: Tiling): Tiling {
  const byAnchor = new Map<number, Domino>();
  for (const d of t.dominoes) byAnchor.set(key(d.r, d.c), d);
  const bad = new Set<Domino>();
  for (const d of t.dominoes) {
    if (d.t === S) {
      const below = byAnchor.get(key(d.r + 1, d.c)); // N directly under an S
      if (below && below.t === N) {
        bad.add(d);
        bad.add(below);
      }
    } else if (d.t === E) {
      const right = byAnchor.get(key(d.r, d.c + 1)); // W directly right of an E
      if (right && right.t === W) {
        bad.add(d);
        bad.add(right);
      }
    }
  }
  return { n: t.n, dominoes: t.dominoes.filter((d) => !bad.has(d)) };
}

/**
 * Slide into AD(n+1). Composing the concentric embed (+1,+1) with a one-cell
 * move in the domino's own direction gives these anchor remaps (derived once,
 * verified against the AD(1)→AD(2) trace in the tests):
 */
export function slideGrow(t: Tiling): Tiling {
  const moved: Domino[] = t.dominoes.map((d) => {
    switch (d.t) {
      case N:
        return { t: N, r: d.r, c: d.c + 1 };
      case S:
        return { t: S, r: d.r + 2, c: d.c + 1 };
      case E:
        return { t: E, r: d.r + 1, c: d.c + 2 };
      default:
        return { t: W, r: d.r + 1, c: d.c }; // W
    }
  });
  return { n: t.n + 1, dominoes: moved };
}

/**
 * Fill the vacated cells. The empty region decomposes uniquely into 2×2
 * blocks; scanning row-major, the first empty cell is always a block's
 * top-left, so we can fill greedily.
 */
export function create(t: Tiling, rng: Rng): Tiling {
  const size = 2 * t.n;
  const grid = rasterize(t); // occupied cells from the slid dominoes
  const dominoes = [...t.dominoes];
  const at = (r: number, c: number) => grid[r * size + c];
  const put = (r: number, c: number, v: CellLabel) => {
    grid[r * size + c] = v;
  };
  const emptyHole = (r: number, c: number) => at(r, c) === EMPTY && inDiamond(r, c, t.n);
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      // Cells outside the diamond are permanently empty — never fill them.
      if (!emptyHole(r, c)) continue;
      // (r,c) is an in-diamond empty cell with nothing empty above/left → it is
      // the top-left of a 2×2 hole; its whole block must be empty and interior.
      if (!emptyHole(r, c + 1) || !emptyHole(r + 1, c) || !emptyHole(r + 1, c + 1)) {
        throw new Error(
          `create: empty cell (${r},${c}) is not a 2×2 block corner — invalid tiling`,
        );
      }
      if (rng() < 0.5) {
        dominoes.push({ t: N, r, c }, { t: S, r: r + 1, c });
        put(r, c, N);
        put(r, c + 1, N);
        put(r + 1, c, S);
        put(r + 1, c + 1, S);
      } else {
        dominoes.push({ t: W, r, c }, { t: E, r, c: c + 1 });
        put(r, c, W);
        put(r + 1, c, W);
        put(r, c + 1, E);
        put(r + 1, c + 1, E);
      }
    }
  }
  return { n: t.n, dominoes };
}

/** Grow AD(n) → AD(n+1): destruct, slide, create. */
export function step(t: Tiling, rng: Rng): Tiling {
  return create(slideGrow(destruct(t)), rng);
}

/** A full random tiling of AD(targetN) from a seeded generator. */
export function generate(targetN: number, rng: Rng): Tiling {
  let t = initTiling(rng);
  while (t.n < targetN) t = step(t, rng);
  return t;
}

/**
 * Arctic-circle observable. The temperate (disordered) region is the inscribed
 * circle of radius n/√2 (in cell units) about the grid center; outside it the
 * four corners freeze into brickwork of a single type — N up top, S below, W to
 * the left, E to the right. We report the fraction of dominoes whose center
 * lies *outside* that circle and whose type matches its corner's frozen type;
 * this tends to 1 as n grows and is a crisp proxy for "the corners have frozen".
 */
export function frozenFraction(t: Tiling): number {
  const center = t.n - 0.5;
  const radius = t.n / Math.SQRT2;
  let outside = 0;
  let match = 0;
  for (const d of t.dominoes) {
    const [[r0, c0], [r1, c1]] = dominoCells(d);
    const dr = (r0 + r1) / 2 - center;
    const dc = (c0 + c1) / 2 - center;
    if (Math.hypot(dr, dc) <= radius) continue; // temperate: no frozen expectation
    outside++;
    const expected = Math.abs(dr) >= Math.abs(dc) ? (dr < 0 ? N : S) : dc < 0 ? W : E;
    if (d.t === expected) match++;
  }
  return outside === 0 ? 1 : match / outside;
}

/**
 * Validity check used by the tests: every AD(n) cell covered exactly once by a
 * domino wholly inside the diamond, nothing outside, and n(n+1) dominoes.
 * Returns null when valid, else a description of the first problem.
 */
export function tilingProblem(t: Tiling): string | null {
  const size = 2 * t.n;
  const cover = new Int8Array(size * size);
  for (const d of t.dominoes) {
    for (const [r, c] of dominoCells(d)) {
      if (r < 0 || c < 0 || r >= size || c >= size) return `domino cell (${r},${c}) off-grid`;
      if (!inDiamond(r, c, t.n)) return `domino cell (${r},${c}) outside AD(${t.n})`;
      if (cover[r * size + c]++) return `cell (${r},${c}) covered twice`;
    }
  }
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const want = inDiamond(r, c, t.n) ? 1 : 0;
      if (cover[r * size + c] !== want) {
        return `cell (${r},${c}) coverage ${cover[r * size + c]} but expected ${want}`;
      }
    }
  }
  if (t.dominoes.length !== t.n * (t.n + 1)) {
    return `${t.dominoes.length} dominoes, expected ${t.n * (t.n + 1)}`;
  }
  return null;
}
