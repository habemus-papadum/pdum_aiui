/**
 * scroll-cue.tsx — the title slide's "there's more below" affordance: a
 * circled chevron pinned bottom-center, bobbing gently (CSS owns the bob,
 * gated on `prefers-reduced-motion: no-preference`), fading out the moment
 * the deck leaves slide 0 and back in at the top. A button, not an ornament —
 * clicking it advances, so the very first navigation needs no keyboard and no
 * discovery.
 *
 * Lineage: the fai-canteen landing page's `.scroll-cue`; this component only
 * flips the `is-hidden` class — the half-second fade lives in the stylesheet,
 * and with CSS alone the cue simply stays visible (fails open).
 */
import type { JSX } from "@solidjs/web";
import type { DeckModel } from "./model";

export function ScrollCue(props: { model: DeckModel }): JSX.Element {
  const hidden = (): boolean => props.model.slide.get() > 0;
  return (
    <button
      type="button"
      class={`aiui-deck-cue${hidden() ? " is-hidden" : ""}`}
      tabindex={hidden() ? "-1" : "0"}
      aria-hidden={hidden() ? "true" : "false"}
      aria-label="next slide"
      onClick={() => props.model.goTo(props.model.slide.get() + 1)}
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
