/**
 * step-dots.tsx — the scene position indicator: one dot per state of the
 * CURRENT slide (its initial state + each scene), bottom-center, visible only
 * while the slide has scenes at all. Played states fill, the current one
 * rings — so the affordance says both "this slide has interior steps" and
 * "how far in you are", the piece of information the cue's chevron cannot
 * carry. Each dot is a button: tapping jumps straight to that scene state
 * (still within the slide — the deck's slide-grained surfaces are the HUD
 * and the URL, untouched here).
 */
import type { JSX } from "@solidjs/web";
import { Repeat, Show, untrack } from "solid-js";
import type { DeckModel } from "./model";

export function StepDots(props: { model: DeckModel }): JSX.Element {
  const m = props.model;
  const steps = (): number => m.stepsOf(m.slide.get());
  const current = (): number => m.stepAt(m.slide.get());
  return (
    <Show when={steps() > 0}>
      {/* biome-ignore lint/a11y/useSemanticElements: a fieldset is form
          semantics; these dots are a navigation group, and role="group" with
          a label is the honest description. */}
      <div class="aiui-deck-dots" role="group" aria-label="scene position">
        <Repeat count={steps() + 1}>
          {(k) => (
            <button
              type="button"
              class={`aiui-deck-dot${k <= current() ? " is-played" : ""}${
                k === current() ? " is-current" : ""
              }`}
              aria-label={`scene ${k + 1} of ${steps() + 1}`}
              aria-current={k === current() ? "step" : undefined}
              onClick={() =>
                m.goToFrame(
                  untrack(() => m.slide.get()),
                  k,
                )
              }
            />
          )}
        </Repeat>
      </div>
    </Show>
  );
}
