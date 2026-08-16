/**
 * rng.ts — seeded randomness for every simulator on the page (layer 1, pure).
 *
 * Everything the notebook shows is drawn from these generators with an explicit
 * seed, so a given (controls, seed) pair renders the identical picture on every
 * mount, refit, and hot reload. Mulberry32 is small, fast, and good enough for
 * teaching-grade Monte Carlo.
 */

export type Rng = () => number;

/** Mulberry32: a 32-bit seeded PRNG returning uniforms in [0, 1). */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A standard-normal sampler over `rng` (Box–Muller, caching the spare). */
export function gaussian(rng: Rng): Rng {
  let spare: number | null = null;
  return () => {
    if (spare !== null) {
      const v = spare;
      spare = null;
      return v;
    }
    let u = 0;
    let v = 0;
    while (u === 0) u = rng();
    v = rng();
    const mag = Math.sqrt(-2 * Math.log(u));
    spare = mag * Math.sin(2 * Math.PI * v);
    return mag * Math.cos(2 * Math.PI * v);
  };
}
