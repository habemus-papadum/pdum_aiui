/**
 * stats.ts — pure, cheap reductions over a field readback.
 *
 * Pure on purpose: these run on the main thread every snapshot (~4 Hz over
 * 65k pixels — trivial), and being DOM-free they are unit-testable headlessly
 * (see stats.test.ts). The expensive structure analysis lives in the worker;
 * the split is the "cheap inline, heavy in a worker" budget rule.
 */

export interface FieldStats {
  /** Fraction of pixels where V > 0.1 — how much pattern exists. */
  coverage: number;
  /** Mean U and V over the field. */
  meanU: number;
  meanV: number;
  /** Std deviation of V — "contrast": 0 for uniform, high for crisp pattern. */
  contrast: number;
}

/** `bytes` is RGBA rows with R = U·255, G = V·255 (engine readback format). */
export function computeFieldStats(bytes: Uint8Array, width: number, height: number): FieldStats {
  const n = width * height;
  let sumU = 0;
  let sumV = 0;
  let sumVV = 0;
  let covered = 0;
  for (let i = 0; i < n; i++) {
    const u = bytes[i * 4] / 255;
    const v = bytes[i * 4 + 1] / 255;
    sumU += u;
    sumV += v;
    sumVV += v * v;
    if (v > 0.1) covered++;
  }
  const meanU = sumU / n;
  const meanV = sumV / n;
  const variance = Math.max(sumVV / n - meanV * meanV, 0);
  return {
    coverage: covered / n,
    meanU,
    meanV,
    contrast: Math.sqrt(variance),
  };
}
