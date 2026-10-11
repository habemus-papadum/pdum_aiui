import type { CaptureTarget } from "./types";

export const CAPTURE_BOUNDARY_SELECTOR = "[data-screen-capture-target]";

/** Declare an existing JSX element as a capture boundary without adding a wrapper. */
export function captureTargetProps(label?: string) {
  return {
    "data-screen-capture-target": "",
    "data-capture-label": label,
    style: { isolation: "isolate", "transform-style": "flat" } as const,
  };
}

/** Validate our explicit boundary contract; the browser still decides native eligibility. */
export function elementCaptureIssue(element: Element): string | undefined {
  if (!element.matches(CAPTURE_BOUNDARY_SELECTOR))
    return "Element only needs a declared capture boundary. Pick a capture boundary or use Region.";
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  if (style?.isolation !== "isolate" || style.transformStyle !== "flat")
    return "This capture boundary is missing its isolation styles. Restore its capture styles or use Region.";
  return undefined;
}

/** Known reasons for absent frames, without treating a still image as failed capture. */
export function targetUnavailableReason(target: CaptureTarget): string | undefined {
  const element = target.element;
  if (!element.isConnected) return "The capture target was removed. Select its replacement.";
  if (target.mode === "element") {
    const issue = elementCaptureIssue(element);
    if (issue) return issue;
    if (element.getClientRects().length > 1)
      return "This capture boundary spans multiple layout fragments. Choose a single area or use Region.";
  }
  const rect = element.getBoundingClientRect();
  const win = element.ownerDocument.defaultView;
  const style = win?.getComputedStyle(element);
  if (
    rect.width <= 0 ||
    rect.height <= 0 ||
    style?.visibility === "hidden" ||
    style?.visibility === "collapse"
  )
    return "The capture target is hidden or has no visible area. Show it again or choose another target.";
  if (
    win &&
    (rect.bottom <= 0 ||
      rect.right <= 0 ||
      rect.top >= win.innerHeight ||
      rect.left >= win.innerWidth)
  )
    return "The capture target is outside the visible page. Use Show target to bring it into view.";
  return undefined;
}
