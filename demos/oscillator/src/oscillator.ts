/**
 * oscillator.ts — the pure math (playbook layer 1). Realm-free: no framework,
 * no window, no time — the same functions run in the slice's cells, in a
 * worker if one is ever needed, and under Vitest.
 */

/** Parameters of a damped sinusoid x(t) = A·e^(−ζ·2πf·t)·sin(2πf·t + φ). */
export interface OscillatorParams {
  /** Natural frequency, Hz. */
  freq: number;
  /** Damping ratio ζ (0 = undamped). */
  damping: number;
  /** Peak amplitude A. */
  amp: number;
  /** Phase offset φ, radians. */
  phase: number;
}

/** Displacement at time `t` (seconds). */
export function displacementAt(p: OscillatorParams, t: number): number {
  const omega = 2 * Math.PI * p.freq;
  return p.amp * Math.exp(-p.damping * omega * t) * Math.sin(omega * t + p.phase);
}

/**
 * Sample the trace over `[0, seconds)` at `samples` uniform points.
 * Deterministic, allocation-per-call — cheap enough for a synchronous cell.
 */
export function oscillatorTrace(
  p: OscillatorParams,
  seconds: number,
  samples: number,
): Float64Array {
  const out = new Float64Array(samples);
  for (let i = 0; i < samples; i++) {
    out[i] = displacementAt(p, (i / samples) * seconds);
  }
  return out;
}
