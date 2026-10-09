/**
 * status.ts — one dot for the collapsed dock: the most urgent of the
 * sessions' statuses, so the pill says at a glance whether anything is live.
 */
const ORDER = ["error", "connecting", "closing", "live", "parked", "idle"] as const;

/** The most urgent status among the given (unknown ones rank as idle). */
export function combinedStatus(...statuses: string[]): string {
  let best = ORDER.length - 1;
  for (const s of statuses) {
    const i = ORDER.indexOf(s as (typeof ORDER)[number]);
    if (i !== -1 && i < best) best = i;
  }
  return ORDER[best] ?? "idle";
}
