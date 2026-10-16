/** Browser attachment for an application-defined, uniform content-to-overlay mapping. */
import { type InkTransform, validateTransform } from "./geometry";

export interface InkAttachmentSurface {
  readonly canvas: HTMLCanvasElement;
  /** Changing coordinates cancels the surface's current input contacts. */
  setViewport(transform: InkTransform): void;
  /** Disabling cancels local input and pauses rendering without changing completed ink. */
  setActive(active: boolean): void;
}

export interface InkAttachmentOptions {
  surface: InkAttachmentSurface;
  scrollTarget: EventTarget;
  /** Recompute the absolute mapping; the application determines what its ink is attached to. */
  viewport: () => InkTransform;
  /** Elements whose size changes require recomputing the mapping. Defaults to the canvas. */
  resizeTargets?: readonly Element[];
}

export interface InkAttachment {
  /** Recompute a valid mapping after scrolling, moving, resizing, or application updates. */
  refresh(): void;
  /** Hide the overlay and cancel its input when reflow makes the mapping uncertain. */
  invalidate(): void;
  /** Resume after the application has established the mapping to use. */
  resume(): void;
  valid(): boolean;
  /** Stop observing and deactivate this attachment. The document remains available. */
  dispose(): void;
}

/**
 * Follows one scroll container and explicit size dependencies. It does not infer
 * element anchors or decide how annotations should survive nonuniform reflow.
 */
export function bindInkAttachment(options: InkAttachmentOptions): InkAttachment {
  const { surface } = options;
  const visibility = surface.canvas.style.visibility;
  let current: InkTransform | undefined;
  let valid = false;
  let disposed = false;
  let observer: ResizeObserver | undefined;

  const invalidate = () => {
    valid = false;
    surface.canvas.style.visibility = "hidden";
    surface.setActive(false);
  };

  const apply = () => {
    const transform = options.viewport();
    validateTransform(transform);
    if (
      !current ||
      current.x !== transform.x ||
      current.y !== transform.y ||
      current.scale !== transform.scale ||
      (current.rotation ?? 0) !== (transform.rotation ?? 0)
    ) {
      surface.setViewport(transform);
      current = { ...transform };
    }
  };

  const refresh = () => {
    if (disposed || !valid) return;
    try {
      apply();
    } catch (error) {
      invalidate();
      throw error;
    }
  };

  const resume = () => {
    if (disposed) return;
    try {
      apply();
      valid = true;
      surface.canvas.style.visibility = visibility;
      surface.setActive(true);
    } catch (error) {
      invalidate();
      throw error;
    }
  };

  // Establish a valid mapping before installing listeners, so initialization failure leaks none.
  resume();
  options.scrollTarget.addEventListener("scroll", refresh);
  window.addEventListener("resize", refresh);
  if (typeof ResizeObserver !== "undefined") {
    observer = new ResizeObserver(refresh);
    for (const target of options.resizeTargets ?? [surface.canvas]) observer.observe(target);
  }

  return {
    refresh,
    invalidate: () => {
      if (!disposed) invalidate();
    },
    resume,
    valid: () => valid && !disposed,
    dispose() {
      if (disposed) return;
      disposed = true;
      options.scrollTarget.removeEventListener("scroll", refresh);
      window.removeEventListener("resize", refresh);
      observer?.disconnect();
      invalidate();
    },
  };
}
