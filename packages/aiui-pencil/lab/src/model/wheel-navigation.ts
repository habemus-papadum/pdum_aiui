import type { InkDraft } from "@habemus-papadum/aiui-pencil";

/**
 * A pinch can supersede an ambiguous mouse draft. This does not identify a finger:
 * a real Ctrl+wheel gesture also takes precedence over ordinary mouse drawing.
 * Wacom may label pen input as mouse, so retain any pressure/tilt/barrel evidence
 * from the entire draft. An upright mouse-labelled pen reporting only 0/0.5 is
 * indistinguishable here; this fallback applies only once pinch is delivered.
 */
export function mouseDraftCanYieldToPinch(draft: Pick<InkDraft, "points">): boolean {
  return (
    draft.points.length > 0 &&
    draft.points.every(
      (point) =>
        point.kind === "mouse" &&
        (point.pressure === 0 || point.pressure === 0.5) &&
        Math.abs(point.altitude - Math.PI / 2) < 1e-6 &&
        point.twist === 0,
    )
  );
}
