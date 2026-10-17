/**
 * cost.ts — what a session costs. Voice is flat: $0.05 per minute, billed per
 * second, silence and mute INCLUDED (an idle open session is $3/hour — the
 * reason the oracle's free "park" became close-and-reseed here). Backend
 * spend is the backend's own bill and is reported by each delegator.
 */

export const LIVE_USD_PER_MINUTE = 0.05;

/** Voice spend for `seconds` of session time. */
export function priceLiveSeconds(seconds: number): number {
  return (Math.max(0, seconds) / 60) * LIVE_USD_PER_MINUTE;
}

export function formatUsd(usd: number): string {
  if (usd < 0.01) {
    return `$${usd.toFixed(4)}`;
  }
  if (usd < 1) {
    return `$${usd.toFixed(3)}`;
  }
  return `$${usd.toFixed(2)}`;
}

export function formatSeconds(seconds: number): string {
  const whole = Math.floor(seconds);
  const minutes = Math.floor(whole / 60);
  const rest = whole % 60;
  return minutes > 0 ? `${minutes}m${rest.toString().padStart(2, "0")}s` : `${rest}s`;
}
