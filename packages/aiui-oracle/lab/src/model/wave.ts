/** wave.ts — the pure model: one sample of the chosen waveform at a phase. */

export type Waveform = "sine" | "square" | "saw";

export function waveValue(kind: Waveform, phase: number): number {
  const turn = phase / (2 * Math.PI);
  const frac = turn - Math.floor(turn);
  switch (kind) {
    case "sine":
      return Math.sin(phase);
    case "square":
      return frac < 0.5 ? 1 : -1;
    case "saw":
      return 2 * frac - 1;
  }
}
