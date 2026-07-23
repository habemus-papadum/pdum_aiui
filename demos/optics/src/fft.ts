/**
 * fft.ts — a minimal, dependency-free radix-2 FFT on split complex arrays
 * (Float64Array re/im, in place). This is the only "numerics" in the wave
 * engine: everything else (propagation, far fields) is a few lines on top.
 *
 * Conventions: `fft` computes X[k] = Σ_n x[n]·e^{-2πi kn/N} (unnormalized);
 * `ifft` is the inverse WITH the 1/N factor, so ifft(fft(x)) === x.
 */

/** True if n is a power of two (and ≥ 1). */
export function isPow2(n: number): boolean {
  return n >= 1 && (n & (n - 1)) === 0;
}

/** Smallest power of two ≥ n. */
export function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/** In-place radix-2 Cooley–Tukey FFT. Length must be a power of two. */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  if (!isPow2(n)) throw new Error(`fft length ${n} is not a power of two`);
  if (im.length !== n) throw new Error("fft: re/im length mismatch");

  // bit-reversal permutation
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }

  // butterflies
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      const half = len >> 1;
      for (let k = 0; k < half; k++) {
        const a = i + k;
        const b = a + half;
        const tRe = re[b] * curRe - im[b] * curIm;
        const tIm = re[b] * curIm + im[b] * curRe;
        re[b] = re[a] - tRe;
        im[b] = im[a] - tIm;
        re[a] += tRe;
        im[a] += tIm;
        const nRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nRe;
      }
    }
  }
}

/** In-place inverse FFT (includes the 1/N normalization). */
export function ifft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  // conjugate → forward FFT → conjugate, scale
  for (let i = 0; i < n; i++) im[i] = -im[i];
  fft(re, im);
  const s = 1 / n;
  for (let i = 0; i < n; i++) {
    re[i] *= s;
    im[i] = -im[i] * s;
  }
}

/**
 * FFT sample frequencies (cycles per unit), matching numpy's fftfreq layout:
 * [0, 1, …, N/2−1, −N/2, …, −1] / (N·d).
 */
export function fftfreq(n: number, d: number): Float64Array {
  const f = new Float64Array(n);
  const half = n >> 1;
  for (let i = 0; i < half; i++) f[i] = i / (n * d);
  for (let i = half; i < n; i++) f[i] = (i - n) / (n * d);
  return f;
}
