/**
 * hues.ts — the lab's term colors. Fixed assignment: a color follows its
 * term, never its rank (the dataviz rule). The chart trio from the design
 * system, plus the brick status red as a fourth data hue — a lab liberty.
 */
import { CHART, TOKENS } from "@habemus-papadum/aiui-design";

export const HUE = {
  policy: CHART.blue,
  value: CHART.green,
  entropy: CHART.amber,
  kl: TOKENS.alarm,
} as const;

/** The derivation's terms: the square/linear/constant trio keep their hues
 * through every step; the completed square is the fourth. */
export const HUE_Q: Record<string, string> = {
  sq: CHART.blue,
  lin: CHART.green,
  cst: CHART.amber,
  rhs: TOKENS.inkMuted,
  sq2: TOKENS.alarm,
  sq2r: TOKENS.alarm,
  x: CHART.blue,
};

/** The clipping lens: which argument the min took, which bound did the clipping. */
export const HUE_CLIP = {
  unclipped: CHART.blue,
  clipped: TOKENS.alarm,
  below: CHART.amber,
  above: CHART.green,
} as const;

/** A hue at an intensity: full at share 1, nearly ghost at 0 (sqrt so small
 * terms still read). */
export function intensity(hue: string, share: number): string {
  const pct = Math.round(30 + 70 * Math.sqrt(Math.max(0, Math.min(1, share))));
  return `color-mix(in oklab, ${hue} ${pct}%, ${TOKENS.ghost})`;
}

/** The Fourier ramp: harmonic n of N, blue fading toward green. */
export function ramp(n: number, total: number): string {
  const t = total <= 1 ? 0 : (n - 1) / (total - 1);
  return `color-mix(in oklab, ${CHART.blue} ${Math.round(100 - 100 * t)}%, ${CHART.green})`;
}
