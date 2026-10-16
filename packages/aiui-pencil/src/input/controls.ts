/** Palm protection for controls outside the ink region. */
import type { PenActivity } from "./pointer";
import { withinPenCooldown } from "./policy";

export interface PenControlOptions {
  now?: () => number;
  /** Refuse touches this long after a pen lifts; default 350 ms. */
  cooldownMs?: number;
  /** Suppress the trailing click after a refused contact; default 80 ms. */
  clickTailMs?: number;
}

export function penWriting(
  activity: PenActivity | undefined,
  options: PenControlOptions = {},
): boolean {
  return (
    activity !== undefined &&
    withinPenCooldown(
      activity.penDown(),
      activity.lastPenUp(),
      (options.now ?? (() => performance.now()))(),
      options.cooldownMs ?? 350,
    )
  );
}

/**
 * Refused touches remain refused through release, even after writing ends.
 * Pens, mice, and deliberate touches outside the writing interval can use controls.
 */
export function guardPenControls(
  element: HTMLElement,
  activity: () => PenActivity | undefined,
  options: PenControlOptions = {},
): () => void {
  const now = options.now ?? (() => performance.now());
  const refused = new Set<number>();
  let swallowClicksUntil = Number.NEGATIVE_INFINITY;
  const down = (event: PointerEvent) => {
    if (event.pointerType === "touch" && penWriting(activity(), { ...options, now })) {
      refused.add(event.pointerId);
      event.preventDefault();
      event.stopPropagation();
    }
  };
  const release = (event: PointerEvent) => {
    if (refused.delete(event.pointerId)) {
      event.preventDefault();
      event.stopPropagation();
      swallowClicksUntil = now() + (options.clickTailMs ?? 80);
    }
  };
  const click = (event: MouseEvent) => {
    if (now() < swallowClicksUntil) {
      event.preventDefault();
      event.stopPropagation();
    }
  };
  const cancel = () => {
    if (refused.size > 0) swallowClicksUntil = now() + (options.clickTailMs ?? 80);
    refused.clear();
  };
  element.addEventListener("pointerdown", down, true);
  element.addEventListener("pointerup", release, true);
  element.addEventListener("pointercancel", release, true);
  element.addEventListener("lostpointercapture", release, true);
  element.addEventListener("click", click, true);
  const view = element.ownerDocument.defaultView;
  view?.addEventListener("blur", cancel);
  return () => {
    element.removeEventListener("pointerdown", down, true);
    element.removeEventListener("pointerup", release, true);
    element.removeEventListener("pointercancel", release, true);
    element.removeEventListener("lostpointercapture", release, true);
    element.removeEventListener("click", click, true);
    view?.removeEventListener("blur", cancel);
    refused.clear();
  };
}
