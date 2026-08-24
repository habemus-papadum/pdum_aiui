/**
 * scroll-cue.tsx — the "there's more" affordance: a circled chevron pinned
 * bottom-center, bobbing gently (CSS owns the bob, gated on
 * `prefers-reduced-motion: no-preference`). A button, not an ornament —
 * tapping it moves exactly ONE frame (the same unit as a scroll: the next
 * scene, or the next slide), so the very first navigation needs no keyboard
 * and no discovery, and the cue can never blow past an unplayed scene.
 *
 * When it shows: immediately on the title frame (the classic splash invite),
 * then it retires on first movement and REAPPEARS after `idleMs` (default
 * 10 s) of rest on any frame — a quiet "this is how you continue" for a
 * viewer who stalled. It points down while there is anything ahead and flips
 * up at the very end of the deck (where the only step left is back).
 *
 * Lineage: the fai-canteen landing page's `.scroll-cue`; this component only
 * flips classes — the half-second fade lives in the stylesheet, and with CSS
 * alone the cue simply stays visible (fails open).
 */
import type { JSX } from "@solidjs/web";
import { createEffect, createSignal, onCleanup } from "solid-js";
import type { DeckModel } from "./model";

export function ScrollCue(props: { model: DeckModel; idleMs?: number }): JSX.Element {
  const m = props.model;
  const [resting, setResting] = createSignal(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let first = true;

  createEffect(
    () => ({ slide: m.slide.get(), step: m.step.get() }),
    (frame) => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      if (first) {
        first = false;
        if (frame.slide === 0 && frame.step === 0) {
          // Mounted on the title frame: invite immediately. A session
          // restored mid-deck earns the cue after idleMs like any rest.
          setResting(true);
          return;
        }
      }
      setResting(false);
      timer = setTimeout(() => setResting(true), props.idleMs ?? 10_000);
    },
  );
  onCleanup(() => {
    if (timer !== undefined) clearTimeout(timer);
  });

  const up = (): boolean => m.atEnd();
  const hidden = (): boolean => !resting() || (m.atStart() && m.atEnd());
  return (
    <button
      type="button"
      class={`aiui-deck-cue${hidden() ? " is-hidden" : ""}${up() ? " is-up" : ""}`}
      tabindex={hidden() ? "-1" : "0"}
      aria-hidden={hidden() ? "true" : "false"}
      aria-label={up() ? "one step back" : "one step forward"}
      onClick={() => (up() ? m.goBack() : m.goForward())}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <title>scroll</title>
        <path
          d="M6 9l6 6 6-6"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    </button>
  );
}
