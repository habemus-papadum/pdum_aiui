/**
 * "Has the user done anything to this page since the last frame?" — the gate
 * the screen share's **smart mode** samples on.
 *
 * There is no browser API for this. `navigator.userActivation.isActive` is the
 * nearest thing and answers a different question: it is gesture-only, and its
 * window is a fixed ~5 s the page cannot align with a configurable cadence. So
 * this is a small listener set, and the whole design is in *which* events count.
 *
 * **A bare `pointermove` does not count.** Nudging the mouse changes nothing on
 * screen, and a share that re-fires on every stray hover is machine-gun mode
 * with extra steps. A move *with a button held* does count — that is a slider
 * being dragged, a canvas being drawn on, a handle being pulled, which is
 * exactly the case the smart mode exists for ("I want to talk about this while
 * I move it"). Presses, keys, and wheels count outright.
 *
 * Deliberately blind to everything the page does on its own — a chart finishing
 * its transition, an async load, HMR landing, the overlay's own recording badge
 * blinking. A `MutationObserver` would see all of those, and in an app that
 * animates it would sit permanently armed, which is machine-gun mode again. If
 * you later want "capture while the app moves and I narrate", that is a real
 * feature and it needs a real signal (an app-declared "I changed" hook, or a
 * frame differencer), not a DOM firehose.
 *
 * Remote sources with no DOM events of their own — an iPad's Apple Pencil
 * arriving over the paint relay — call {@link InteractionMonitor.note}.
 */

/** The events that mean "the human did something to the page". */
const PRESS_EVENTS = ["pointerdown", "pointerup", "wheel", "keydown"] as const;

export interface InteractionMonitor {
  /**
   * Whether an interaction happened since the previous call, **and clear the
   * flag**. Read-and-clear on purpose: the sampler asks once per tick, and a
   * frame it decides to capture consumes the interaction that justified it.
   */
  consume(): boolean;
  /** Whether an interaction is pending, without clearing (HUD, tests). */
  pending(): boolean;
  /** Record an interaction from a source with no DOM event (remote ink). */
  note(): void;
  /** Drop the listeners. */
  dispose(): void;
}

/**
 * Watch `target` for meaningful input. Capture-phase and passive: the monitor
 * observes, never interferes — an app that stops propagation still gets seen,
 * and a `pointermove` listener that can't preventDefault is one the browser
 * need not wait for.
 */
export function watchInteraction(target: Window = window): InteractionMonitor {
  let dirty = false;
  const mark = (): void => {
    dirty = true;
  };
  // A move only counts while a button is held — see the module doc.
  const onMove = (event: Event): void => {
    if ((event as PointerEvent).buttons !== 0) {
      dirty = true;
    }
  };

  const options = { capture: true, passive: true } as const;
  for (const type of PRESS_EVENTS) {
    target.addEventListener(type, mark, options);
  }
  target.addEventListener("pointermove", onMove, options);

  return {
    consume() {
      const was = dirty;
      dirty = false;
      return was;
    },
    pending: () => dirty,
    note: mark,
    dispose() {
      for (const type of PRESS_EVENTS) {
        target.removeEventListener(type, mark, options);
      }
      target.removeEventListener("pointermove", onMove, options);
    },
  };
}
