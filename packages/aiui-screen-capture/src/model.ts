import type { CaptureTarget } from "./types";

/** FPS over an observation window, accounting for callbacks that skipped presented frames. */
export function frameRate(
  previous: { time: number; frames: number },
  next: { time: number; frames: number },
): number | undefined {
  const elapsed = next.time - previous.time;
  const frames = next.frames - previous.frames;
  return elapsed > 0 && frames >= 0 ? (frames * 1000) / elapsed : undefined;
}

export function targetLabel(target: CaptureTarget): string {
  return (
    target.label ||
    target.element.getAttribute("aria-label") ||
    target.element.getAttribute("data-capture-label") ||
    (target.element.id ? `#${target.element.id}` : target.element.tagName.toLowerCase())
  );
}
