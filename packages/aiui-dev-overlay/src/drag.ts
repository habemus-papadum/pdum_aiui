/**
 * Make a fixed-position overlay element draggable — the HUD pill, the
 * transcript preview, and the intent tool's fab/panel all float over an app
 * whose content they inevitably cover, so the user must be able to shove them
 * aside.
 *
 * Design constraints (why this isn't a generic drag library):
 *  - **Clicks must survive.** The drag surfaces contain live controls (the arm
 *    button, the fab that toggles the panel). So nothing engages until the
 *    pointer moves {@link DEFAULT_THRESHOLD}px from the press; an engaged drag
 *    swallows the click that fires after its pointerup (capture-phase, so the
 *    button never sees it).
 *  - **Anchor conversion happens lazily.** These elements are positioned with
 *    right/bottom offsets (and the preview centers itself with a translateX).
 *    On first engagement the element's current viewport rect is frozen into
 *    explicit left/top (right/bottom/transform cleared), and dragging moves
 *    that. Until you drag, the CSS anchoring — and anything responsive about
 *    it — keeps working untouched.
 *  - **No document-level listeners.** `setPointerCapture` on the handle keeps
 *    move/up events flowing even when the pointer leaves it, so everything
 *    stays scoped to the element and dies with it.
 *  - Text-editing targets (inputs, textareas, contenteditable) never start a
 *    drag — drag-selection inside them must keep meaning selection. Callers
 *    exclude further regions via {@link DraggableOptions.exclude} (the
 *    preview's transcript body, where selection is the correction gesture).
 *
 * The drag deliberately wins over the page-level gestures (ink, the shot
 * veil): these elements already sit above both layers in z-order, so a drag
 * that starts on them never reaches the canvases underneath.
 */

const DEFAULT_THRESHOLD = 4;

export interface DraggableOptions {
  /** The grip that initiates dragging; the whole element when omitted. */
  handle?: HTMLElement;
  /** Extra "not a grip" test (e.g. the preview's selectable transcript body). */
  exclude?: (target: Element) => boolean;
  /** Pointer travel (px) before the drag engages and the click is forfeited. */
  threshold?: number;
}

/** True for targets where a drag gesture already means something (selection). */
function isEditingTarget(target: Element): boolean {
  return (
    target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]') !==
    null
  );
}

/**
 * Install drag-to-move on `el`. Returns an uninstaller (listeners also die
 * with the element, so calling it is tidiness, not correctness).
 */
export function makeDraggable(el: HTMLElement, options: DraggableOptions = {}): () => void {
  const handle = options.handle ?? el;
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;

  let pressed = false;
  let engaged = false;
  /** Where the pointer went down, and where the element's rect was then. */
  let startX = 0;
  let startY = 0;
  let baseLeft = 0;
  let baseTop = 0;
  let width = 0;
  let height = 0;

  const onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || !event.isPrimary) {
      return;
    }
    const target = event.target as Element | null;
    if (target && (isEditingTarget(target) || options.exclude?.(target))) {
      return;
    }
    pressed = true;
    engaged = false;
    startX = event.clientX;
    startY = event.clientY;
    const rect = el.getBoundingClientRect();
    baseLeft = rect.left;
    baseTop = rect.top;
    width = rect.width;
    height = rect.height;
    // No preventDefault here: an un-engaged press must stay a normal click.
  };

  const engage = (event: PointerEvent): void => {
    engaged = true;
    handle.setPointerCapture(event.pointerId);
    // Freeze the CSS anchoring (right/bottom offsets, the preview's centering
    // translate) into the explicit viewport position it currently resolves to.
    el.style.left = `${baseLeft}px`;
    el.style.top = `${baseTop}px`;
    el.style.right = "auto";
    el.style.bottom = "auto";
    el.style.transform = "none";
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (!pressed) {
      return;
    }
    const dx = event.clientX - startX;
    const dy = event.clientY - startY;
    if (!engaged) {
      if (Math.hypot(dx, dy) < threshold) {
        return;
      }
      engage(event);
    }
    // Clamp fully on-screen so an element can't be flung somewhere unreachable.
    const left = Math.min(Math.max(baseLeft + dx, 0), Math.max(0, window.innerWidth - width));
    const top = Math.min(Math.max(baseTop + dy, 0), Math.max(0, window.innerHeight - height));
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    event.preventDefault();
  };

  const onPointerEnd = (event: PointerEvent): void => {
    if (!pressed) {
      return;
    }
    pressed = false;
    if (engaged && handle.hasPointerCapture?.(event.pointerId)) {
      handle.releasePointerCapture(event.pointerId);
    }
    // `engaged` stays set until the click it must swallow (below) has fired.
  };

  // The click that follows an engaged drag's pointerup would land on whatever
  // control the press started on (the fab, the arm button) — swallow it in the
  // capture phase so moving a control is never also pressing it.
  const onClick = (event: MouseEvent): void => {
    if (engaged) {
      engaged = false;
      event.preventDefault();
      event.stopPropagation();
    }
  };

  handle.addEventListener("pointerdown", onPointerDown);
  handle.addEventListener("pointermove", onPointerMove);
  handle.addEventListener("pointerup", onPointerEnd);
  handle.addEventListener("pointercancel", onPointerEnd);
  handle.addEventListener("click", onClick, true);

  return () => {
    handle.removeEventListener("pointerdown", onPointerDown);
    handle.removeEventListener("pointermove", onPointerMove);
    handle.removeEventListener("pointerup", onPointerEnd);
    handle.removeEventListener("pointercancel", onPointerEnd);
    handle.removeEventListener("click", onClick, true);
  };
}
