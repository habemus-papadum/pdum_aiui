/**
 * types.ts — the payloads that cross the worker boundary.
 *
 * Kept type-only and dependency-free so both the worker and the main-thread
 * cell graph can import them without dragging shuffle math into the page
 * bundle. The worker (shuffle.worker.ts) speaks the @habemus-papadum/aiui-viz
 * worker-stream protocol, so these are its `TIn`/`TOut`.
 */

/** Domino type codes; also the cell labels used on the rasterized grid. */
export const EMPTY = 0;
export const N = 1; // horizontal domino, moves north (up)
export const S = 2; // horizontal domino, moves south (down)
export const E = 3; // vertical domino, moves east (right)
export const W = 4; // vertical domino, moves west (left)

export type DominoType = 1 | 2 | 3 | 4;
export type CellLabel = 0 | 1 | 2 | 3 | 4;

/** A domino is its type plus the (row, col) of its top-left cell (the anchor). */
export interface Domino {
  t: DominoType;
  r: number;
  c: number;
}

/** One growth step of the shuffle, snapshotted for rendering. */
export interface ShuffleFrame {
  /** Aztec-diamond order of this frame. */
  n: number;
  /** Side of the square cell grid (= 2n). */
  size: number;
  /** Row-major cell labels, length size*size (0 empty, else a DominoType). */
  grid: number[];
  /** Number of dominoes = n(n+1). */
  dominoes: number;
  /** Fraction of outside-the-arctic-circle dominoes matching their frozen corner. */
  frozenFraction: number;
}

/** One row of the permanent-vs-formula check. */
export interface PermanentCheck {
  n: number;
  /** Side of the biadjacency matrix (= n(n+1)). */
  size: number;
  /** perm(biadjacency) = number of domino tilings, via Ryser. */
  permanent: number;
  /** The EKLP closed form 2^(n(n+1)/2). */
  formula: number;
  matches: boolean;
}

export interface PermanentResult {
  permanents: PermanentCheck[];
}

export type ShuffleRequest =
  | { kind: "shuffle"; targetN: number; seed: number; emitEvery: number }
  | { kind: "permanents"; maxN: number };
