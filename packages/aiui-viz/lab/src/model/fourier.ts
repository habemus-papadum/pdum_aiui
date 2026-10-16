/**
 * fourier.ts — the square wave's Fourier series, pure:
 *
 *   f(x) = (4/π) Σ_{k odd} (1/k) sin(kx)
 *
 * Harmonic n (1-based) has k = 2n − 1. The page shows the first N terms as
 * pieces of one equation, each with a miniature of its wave, and lets a term
 * be muted — the partial sum then runs without it.
 */

export const MAX_HARMONICS = 9;

export function harmonicK(n: number): number {
  return 2 * n - 1;
}

/** The term's TeX: `\sin x` for k = 1, `\frac{1}{k}\sin kx` after. */
export function harmonicTex(k: number): string {
  return k === 1 ? "\\sin x" : `\\frac{1}{${k}}\\sin ${k}x`;
}

export interface FourierSample {
  x: number;
  /** The target square wave, sign(sin x). */
  square: number;
  /** The partial sum over the unmuted harmonics, 4/π applied. */
  sum: number;
  /** Each harmonic's own contribution, 4/π applied (0 when muted), by n−1. */
  harmonics: number[];
}

/** N harmonics sampled over [−π, π]. */
export function sampleSeries(
  n: number,
  muted: ReadonlySet<number> = new Set(),
  samples = 241,
): FourierSample[] {
  const out: FourierSample[] = [];
  for (let i = 0; i < samples; i++) {
    const x = -Math.PI + (2 * Math.PI * i) / (samples - 1);
    const harmonics: number[] = [];
    let sum = 0;
    for (let j = 1; j <= n; j++) {
      const k = harmonicK(j);
      const h = muted.has(k) ? 0 : ((4 / Math.PI) * Math.sin(k * x)) / k;
      harmonics.push(h);
      sum += h;
    }
    out.push({ x, square: Math.sign(Math.sin(x)), sum, harmonics });
  }
  return out;
}

/** Root-mean-square error of the partial sum against the square wave. */
export function rmsError(samples: readonly FourierSample[]): number {
  const s = samples.reduce((acc, p) => acc + (p.sum - p.square) ** 2, 0);
  return Math.sqrt(s / samples.length);
}

/** An SVG path of sin(kx)/k over one period, amplitude scaled so k = 1 fills
 * the box — the miniature under each term. */
export function miniWavePath(k: number, width: number, height: number, points = 48): string {
  const mid = height / 2;
  const amp = (height / 2 - 1) / k;
  let d = "";
  for (let i = 0; i <= points; i++) {
    const u = i / points;
    const x = u * width;
    const y = mid - amp * Math.sin(k * 2 * Math.PI * u);
    d += `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
  }
  return d;
}
