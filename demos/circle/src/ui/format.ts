/**
 * format.ts — tiny presentation helpers for the readout (playbook layer 3
 * support). Pure string/number formatting, no framework.
 */

/** Red → amber → green across a 0–100 score, for the gauge and its number. */
export function scoreColor(score: number): string {
  const hue = Math.max(0, Math.min(120, score * 1.2));
  return `hsl(${hue} 68% 56%)`;
}

/** A one-word verdict for the score, shown under the gauge. */
export function verdict(score: number): string {
  if (score >= 95) return "near perfect";
  if (score >= 85) return "very round";
  if (score >= 70) return "pretty good";
  if (score >= 50) return "a bit off";
  if (score >= 25) return "wonky";
  return "keep practicing";
}

export const round0 = (n: number): string => `${Math.round(n)}`;
export const round1 = (n: number): string => n.toFixed(1);
export const round2 = (n: number): string => n.toFixed(2);
export const asPct = (fraction: number): string => `${Math.round(fraction * 100)}`;
