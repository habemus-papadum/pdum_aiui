/**
 * wave.ts — the one thing every live specimen on the catalog page moves: a
 * damped wave y(t) = e^{-ζt} · s(2π f t), where s is a sine, a square or a
 * triangle. Pure (playbook layer 1): no framework, no time. The controls in
 * store.ts hold f, ζ and the shape; the cells in graph.ts sample and
 * summarize; the equation, the diagram, the plot, the lens and the card all
 * draw from here.
 */

export type Shape = "sine" | "square" | "triangle";
export const SHAPES: readonly Shape[] = ["sine", "square", "triangle"];

export interface WaveParams {
  /** Frequency f, in hertz. */
  frequency: number;
  /** Damping ζ, per second: the envelope is e^{-ζt}. */
  damping: number;
  shape: Shape;
}

export interface Point {
  t: number;
  y: number;
}

/** The undamped waveform at a phase measured in cycles, in [-1, 1]. */
export function base(shape: Shape, cycles: number): number {
  const phase = cycles - Math.floor(cycles);
  switch (shape) {
    case "sine":
      return Math.sin(2 * Math.PI * phase);
    case "square":
      return phase < 0.5 ? 1 : -1;
    case "triangle":
      return 1 - 4 * Math.abs(phase - 0.5);
  }
}

/** The decay envelope e^{-ζt}. */
export function envelope(damping: number, t: number): number {
  return Math.exp(-damping * t);
}

/** `n` samples of the wave over `duration` seconds, t = 0 inclusive. */
export function sampleWave(p: WaveParams, n = 240, duration = 2): Point[] {
  const out: Point[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const t = (i / (n - 1)) * duration;
    out[i] = { t, y: envelope(p.damping, t) * base(p.shape, p.frequency * t) };
  }
  return out;
}

export interface WaveSummary {
  /** Root mean square of the samples. */
  rms: number;
  /** Largest |y|. */
  peak: number;
  /** Sign changes between consecutive samples. */
  crossings: number;
}

export function waveSummary(points: readonly Point[]): WaveSummary {
  let sq = 0;
  let peak = 0;
  let crossings = 0;
  let lastSign = 0; // the last NONZERO sign: a sample landing on 0 is not a crossing by itself
  for (const { y } of points) {
    sq += y * y;
    peak = Math.max(peak, Math.abs(y));
    const s = Math.sign(y);
    if (s !== 0) {
      if (lastSign !== 0 && s !== lastSign) crossings++;
      lastSign = s;
    }
  }
  return { rms: points.length ? Math.sqrt(sq / points.length) : 0, peak, crossings };
}
