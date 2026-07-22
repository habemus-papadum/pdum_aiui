/**
 * rng.ts — a tiny seedable PRNG (mulberry32).
 *
 * EKLP shuffling flips one fair coin per created 2×2 block; a seeded generator
 * makes a whole tiling reproducible, which is what the determinism unit test
 * and the "regrow from seed s" agent tool both rely on. mulberry32 is a
 * well-known 32-bit generator — good enough statistics for a coin, and it fits
 * in a few lines so the worker stays dependency-free.
 */

export type Rng = () => number;

/** Deterministic float in [0, 1) from a 32-bit seed. */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
