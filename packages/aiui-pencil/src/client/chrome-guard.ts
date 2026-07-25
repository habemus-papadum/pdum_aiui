/**
 * chrome-guard.ts — palm rejection for the chrome AROUND the stage.
 *
 * The stage's pen policy (pen-input.ts) protects the paper; the strip and the
 * host bar are ordinary buttons, and a writing palm lands on them — measured
 * live 2026-07-25: fast writing near the bottom edge pressed UNDO, which
 * reads as "my strokes vanish". The rule that keeps the free hand useful:
 *
 *   - while a pen stroke is IN FLIGHT, every touch on the chrome is refused;
 *   - for a short cooldown after pen-up, still refused (the palm lands a
 *     beat before and lingers a beat after the stroke);
 *   - a touch that was refused at its start stays refused at its end — the
 *     click fires on release, and a palm that rested through three strokes
 *     must not "complete" a button press when it finally lifts;
 *   - pens, mice, and touches outside the windows pass untouched — a
 *     deliberate tap between strokes works, which is why the chrome is not
 *     simply frozen for the whole pen-mode session.
 *
 * Capture-phase, so the refusal beats the buttons' own handlers (and
 * suppresses their :active flash — a palm should not light UNDO up).
 */

import type { PenActivity } from "./pen-input";

/** How long after pen-up the chrome stays refused to touches. */
const CHROME_COOLDOWN_MS = 350;

/** How long after a refused touch lifts its trailing click is swallowed. */
const CLICK_TAIL_MS = 80;

/**
 * Install the guard on one chrome container. `activity` is read lazily — the
 * stage (which owns the pen policy) may bind after the chrome mounts.
 */
export function guardChrome(
  element: HTMLElement,
  activity: () => PenActivity | undefined,
  now: () => number = () => performance.now(),
): void {
  const refused = new Set<number>();
  let swallowClicksUntil = 0;

  const writing = (): boolean => {
    const pen = activity();
    if (pen === undefined) {
      return false;
    }
    return pen.penDown() || (pen.lastPenUp() > 0 && now() - pen.lastPenUp() < CHROME_COOLDOWN_MS);
  };

  element.addEventListener(
    "pointerdown",
    (event) => {
      if (event.pointerType === "touch" && writing()) {
        refused.add(event.pointerId);
        event.preventDefault();
        event.stopPropagation();
      }
    },
    true,
  );

  const release = (event: PointerEvent): void => {
    if (refused.delete(event.pointerId)) {
      event.preventDefault();
      event.stopPropagation();
      swallowClicksUntil = now() + CLICK_TAIL_MS;
    }
  };
  element.addEventListener("pointerup", release, true);
  element.addEventListener("pointercancel", release, true);

  element.addEventListener(
    "click",
    (event) => {
      if (now() < swallowClicksUntil) {
        event.preventDefault();
        event.stopPropagation();
      }
    },
    true,
  );
}
